import type Anthropic from '@anthropic-ai/sdk';
import type { ResolvedConfig } from '../config/types.js';
import { AnthropicClient } from '../api/AnthropicClient.js';
import { ContextManager } from './ContextManager.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';
import { Logger } from '../logger/Logger.js';
import { PermissionGuard } from '../permissions/PermissionGuard.js';
import { ToolDispatcher } from '../tools/ToolDispatcher.js';
import { ReadFileTool } from '../tools/ReadFileTool.js';
import { WriteFileTool } from '../tools/WriteFileTool.js';
import { BashTool } from '../tools/BashTool.js';
import { GlobTool } from '../tools/GlobTool.js';
import { GrepTool } from '../tools/GrepTool.js';
import { EditFileTool } from '../tools/EditFileTool.js';

/** Pending tool call collected during streaming. */
interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool result to append to context after dispatch. */
interface ToolCallResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * ConversationController is the session orchestrator.
 *
 * - Created once per process at startup.
 * - Holds the single ContextManager reference and reassigns it on every turn.
 * - Drives the agentic loop: stream → collect tool_use → dispatch → re-query.
 * - PermissionGuard gates destructive tool calls (write_file, edit_file, bash).
 * - ToolDispatcher routes calls to the correct tool implementation.
 */
export class ConversationController {
  private readonly config: ResolvedConfig;
  private readonly client: AnthropicClient;
  private readonly renderer: OutputRenderer;
  private readonly usage: UsageTracker;
  private readonly logger: Logger;
  private readonly guard: PermissionGuard;
  private readonly dispatcher: ToolDispatcher;
  private context: ContextManager;

  /** Total tool calls in the current user turn. Reset in handleInput(). */
  private toolCallsThisTurn = 0;

  constructor(
    config: ResolvedConfig,
    renderer: OutputRenderer,
    usage: UsageTracker,
    client?: AnthropicClient,
  ) {
    this.config = config;
    this.renderer = renderer;
    this.usage = usage;
    this.client =
      client ??
      new AnthropicClient({
        apiKey: config.apiKey,
        ...(config.apiUrl !== undefined ? { baseURL: config.apiUrl } : {}),
      });
    this.logger = Logger.getInstance(config.debug);
    this.guard = new PermissionGuard(config.permissionMode);

    this.dispatcher = new ToolDispatcher();
    this.dispatcher.register(new ReadFileTool());
    this.dispatcher.register(new WriteFileTool());
    this.dispatcher.register(new BashTool());
    this.dispatcher.register(new GlobTool());
    this.dispatcher.register(new GrepTool());
    this.dispatcher.register(new EditFileTool());

    this.context = new ContextManager();
  }

  /**
   * Handle one user turn.
   *
   * 1. Append user message.
   * 2. Run agentic loop (stream → tool dispatch → re-query).
   * 3. Record turn.
   * 4. Check if compaction is needed.
   */
  async handleInput(userText: string): Promise<void> {
    this.toolCallsThisTurn = 0;
    this.context = this.context.append({ role: 'user', content: userText });

    this.logger.debug('handleInput', {
      turnCount: this.context.turnCount,
      estimatedTokens: this.context.estimatedTokenCount,
    });

    await this.runAgenticLoop();

    this.usage.recordTurn();

    this.context = await this.context.maybeCompactAsync(
      this.client['client'] as Anthropic,
      this.config.model,
    );
  }

  /**
   * Abort the current in-flight API stream.
   * Called by the SIGINT handler (Ctrl+C).
   */
  abort(): void {
    this.client.abort();
  }

  /**
   * Reset conversation history to empty.
   * Called by the /clear slash command.
   */
  reset(): void {
    this.context = this.context.reset();
    this.logger.info('Context cleared');
  }

  /** Current turn count (user messages only). Exposed for /info and exit summary. */
  get turnCount(): number {
    return this.context.turnCount;
  }

  // ── Agentic loop ─────────────────────────────────────────────────────────────

  /**
   * Inner streaming + tool-dispatch loop.
   *
   * Streams from the API, collects tool_use blocks, dispatches them with
   * permission checks, appends results, then re-queries if tools were called.
   * Stops when no tool calls are returned or the tool call limit is reached.
   */
  private async runAgenticLoop(): Promise<void> {
    const messages = this.context.snapshot as Anthropic.MessageParam[];
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.dispatcher.allDefinitions();

    // Collect assistant content blocks for appending after the stream ends.
    const assistantBlocks: Anthropic.ContentBlockParam[] = [];
    const pendingToolCalls: PendingToolCall[] = [];

    this.logger.debug('API stream start', {
      model: this.config.model,
      messageCount: messages.length,
    });

    for await (const event of this.client.stream(
      messages,
      tools,
      systemPrompt,
      this.config.model,
    )) {
      switch (event.type) {
        case 'text_delta':
          this.renderer.streamChunk(event.text);
          assistantBlocks.push({ type: 'text', text: event.text });
          break;

        case 'tool_use':
          this.renderer.flush();
          this.renderer.printToolCall(event.name, event.input);
          assistantBlocks.push({
            type: 'tool_use' as const,
            id: event.id,
            name: event.name,
            input: event.input,
          });
          pendingToolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input as Record<string, unknown>,
          });
          break;

        case 'usage':
          this.usage.record(this.config.model, event.inputTokens, event.outputTokens);
          this.logger.debug('Token usage', {
            model: this.config.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          });
          break;

        case 'message_stop':
          this.renderer.flush();
          break;

        case 'error':
          this.renderer.printError(event.message);
          this.logger.error('Stream error', {
            message: event.message,
            retryable: event.retryable,
          });
          return;
      }
    }

    // Merge consecutive text deltas into a single block for storage.
    const mergedAssistantContent = this.mergeTextBlocks(assistantBlocks);

    this.context = this.context.append({
      role: 'assistant',
      content: mergedAssistantContent as Anthropic.MessageParam['content'],
    });

    if (pendingToolCalls.length === 0) {
      return;
    }

    // Dispatch tool calls sequentially (after streaming completes).
    const toolResults: ToolCallResult[] = [];

    for (const call of pendingToolCalls) {
      this.toolCallsThisTurn++;

      if (this.toolCallsThisTurn > this.config.maxToolCalls) {
        this.renderer.printError(
          `Tool call limit (${String(this.config.maxToolCalls)}) reached. Stopping agentic loop.`,
        );
        toolResults.push({
          toolUseId: call.id,
          content: `Tool call limit (${String(this.config.maxToolCalls)}) reached.`,
          isError: true,
        });
        continue;
      }

      const result = await this.dispatchWithPermission(call);
      this.renderer.printToolResult(result.content, result.isError);
      toolResults.push({
        toolUseId: call.id,
        content: result.content,
        isError: result.isError,
      });
    }

    // Append all tool results as a single user message.
    this.context = this.context.append({
      role: 'user',
      content: toolResults.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      })),
    });

    // Recurse to get the model's response to the tool results.
    await this.runAgenticLoop();
  }

  /**
   * Check permission and dispatch a single tool call.
   * Builds a diff preview for file-modification tools before prompting.
   */
  private async dispatchWithPermission(call: PendingToolCall): Promise<ToolCallResult> {
    // Get diff preview for tools that support it (write_file, edit_file).
    let diffPreview: string | undefined;
    if (this.guard.riskOf(call.name) === 'destructive') {
      diffPreview = await this.dispatcher.getDiffPreview(
        call.name,
        call.input,
        this.config.workingDirectory,
      );
    }

    const summary = this.buildToolSummary(call.name, call.input);
    const allowed = await this.guard.check(call.name, summary, diffPreview);

    if (!allowed) {
      return {
        toolUseId: call.id,
        content: `Operation denied by user.`,
        isError: false,
      };
    }

    const result = await this.dispatcher.dispatch(
      call.name,
      call.input,
      this.config.workingDirectory,
    );
    return {
      toolUseId: call.id,
      content: result.content,
      isError: result.isError,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Build the system prompt for this turn.
   *
   * Phase 1: working directory + current date.
   * Phase 3: adds CLAUDE.md content and git context.
   * Phase 4: adds agent-specific system prompt.
   */
  private buildSystemPrompt(): string {
    const date = new Date().toISOString().split('T')[0] ?? '';
    return [
      `You are CodeAgent, an AI coding assistant.`,
      `Working directory: ${this.config.workingDirectory}`,
      `Today's date: ${date}`,
    ].join('\n');
  }

  /** Build a one-line description of a tool call for the permission prompt. */
  private buildToolSummary(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case 'read_file':
        return `Read "${String(input['path'] ?? '')}"`;
      case 'write_file':
        return `Write to "${String(input['path'] ?? '')}"`;
      case 'edit_file':
        return `Edit "${String(input['file_path'] ?? '')}"`;
      case 'bash':
        return `Run: ${String(input['command'] ?? '').slice(0, 80)}`;
      case 'glob':
        return `Glob: ${String(input['pattern'] ?? '')}`;
      case 'grep':
        return `Grep: ${String(input['pattern'] ?? '')}`;
      default:
        return `Call ${name}`;
    }
  }

  /**
   * Merge consecutive text blocks into a single text block.
   * Non-text blocks (tool_use) are kept as-is.
   */
  private mergeTextBlocks(
    blocks: Anthropic.ContentBlockParam[],
  ): Anthropic.ContentBlockParam[] {
    if (blocks.length === 0) return [];

    const result: Anthropic.ContentBlockParam[] = [];
    let textAccum = '';

    for (const block of blocks) {
      if (block.type === 'text') {
        textAccum += block.text;
      } else {
        if (textAccum) {
          result.push({ type: 'text', text: textAccum });
          textAccum = '';
        }
        result.push(block);
      }
    }

    if (textAccum) {
      result.push({ type: 'text', text: textAccum });
    }

    return result;
  }
}
