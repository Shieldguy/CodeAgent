import type Anthropic from '@anthropic-ai/sdk';
import type { ResolvedConfig } from '../config/types.js';
import { AnthropicClient } from '../api/AnthropicClient.js';
import { ContextManager } from './ContextManager.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';
import { Logger } from '../logger/Logger.js';

/** Maximum tool-call depth per turn (rate limiter, F17). */
const MAX_TOOL_CALLS_PER_TURN = 25;

/**
 * Minimal tool result — Phase 1 has no real tools.
 * Phase 2 replaces this with the full ToolDispatcher result.
 */
interface ToolResult {
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
 * - Phase 1: no real tool dispatch; tool_use events are acknowledged but not executed.
 * - Phase 2: PermissionGuard + ToolDispatcher injected here.
 * - Phase 4: AgentManager injected here for system prompt composition.
 */
export class ConversationController {
  private readonly config: ResolvedConfig;
  private readonly client: AnthropicClient;
  private readonly renderer: OutputRenderer;
  private readonly usage: UsageTracker;
  private readonly logger: Logger;
  private context: ContextManager;

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
        // baseURL is omitted when apiUrl is undefined — SDK uses its default.
        ...(config.apiUrl !== undefined ? { baseURL: config.apiUrl } : {}),
      });
    this.logger = Logger.getInstance(config.debug);
    this.context = new ContextManager();
  }

  /**
   * Handle one user turn.
   *
   * 1. Append user message.
   * 2. Run agentic loop (stream → optional tool calls → re-query).
   * 3. Record turn.
   * 4. Check if compaction is needed.
   */
  async handleInput(userText: string): Promise<void> {
    this.context = this.context.append({ role: 'user', content: userText });

    this.logger.debug('handleInput', {
      turnCount: this.context.turnCount,
      estimatedTokens: this.context.estimatedTokenCount,
    });

    await this.runAgenticLoop(0);

    this.usage.recordTurn();

    // maybeCompactAsync() returns `this` when below threshold — no allocation.
    this.context = await this.context.maybeCompactAsync(
      this.client['client'] as Anthropic, // Internal SDK client for compaction.
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
   * Recurses when the model returns tool_use blocks (up to MAX_TOOL_CALLS_PER_TURN).
   * Returns when the model emits message_stop with no pending tool calls,
   * or when the tool call depth limit is reached.
   *
   * @param depth - Recursion depth; used to enforce the tool call rate limit.
   */
  private async runAgenticLoop(depth: number): Promise<void> {
    if (depth >= MAX_TOOL_CALLS_PER_TURN) {
      this.renderer.printError(
        `Tool call limit (${MAX_TOOL_CALLS_PER_TURN}) reached. Stopping agentic loop.`,
      );
      return;
    }

    const messages = this.context.snapshot as Anthropic.MessageParam[];
    const systemPrompt = this.buildSystemPrompt();

    // Phase 1: no tools available yet (added in Phase 2).
    const tools: Anthropic.Tool[] = [];

    // Collect assistant content blocks for appending after the stream ends.
    // Use ContentBlockParam (the input type) rather than ContentBlock (the output type)
    // because we are constructing messages to send back to the API.
    const assistantBlocks: Anthropic.ContentBlockParam[] = [];
    const toolResults: ToolResult[] = [];

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
          // Phase 1: acknowledge tool calls but do not execute them.
          // Phase 2 replaces this block with real PermissionGuard + ToolDispatcher.
          this.renderer.flush();
          this.renderer.printToolCall(event.name, event.input);
          this.renderer.printInfo('[Tool execution not yet implemented — Phase 2]');

          assistantBlocks.push({
            type: 'tool_use' as const,
            id: event.id,
            name: event.name,
            input: event.input,
          });

          toolResults.push({
            toolUseId: event.id,
            content: 'Tool execution not yet implemented.',
            isError: true,
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
          this.logger.error('Stream error', { message: event.message, retryable: event.retryable });
          return;
      }
    }

    // Merge all text deltas into a single text block for storage.
    // Storing every delta individually would bloat the context unnecessarily.
    const mergedAssistantContent = this.mergeTextBlocks(assistantBlocks);

    this.context = this.context.append({
      role: 'assistant',
      // ContentBlockParam[] is assignable to MessageParam content for assistant role.
      content: mergedAssistantContent as Anthropic.MessageParam['content'],
    });

    // If there were tool calls, append tool results and recurse.
    if (toolResults.length > 0) {
      this.context = this.context.append({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError,
        })),
      });

      await this.runAgenticLoop(depth + 1);
    }
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

  /**
   * Merge consecutive text blocks into a single text block.
   * Non-text blocks (tool_use) are kept as-is.
   * This keeps the stored assistant message compact.
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
