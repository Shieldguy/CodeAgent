import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { loadProjectContextSync } from '../context/ProjectContextLoader.js';
import { loadGitContext, type GitContext } from '../context/GitContextLoader.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { AgentManager } from '../agents/AgentManager.js';
import { SessionHistory, type SessionStats } from './SessionHistory.js';
import { SessionExporter } from './SessionExporter.js';
import type { CommandContext } from '../commands/types.js';

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
 * - Created once per process at startup via the static `create()` factory.
 * - Holds ContextManager, AgentManager, SessionHistory.
 * - Drives the agentic loop: stream → collect tool_use → dispatch → re-query.
 * - Exposes getCommandContext() for the SlashCommandEngine.
 */
export class ConversationController {
  private readonly config: ResolvedConfig;
  private readonly client: AnthropicClient;
  private readonly renderer: OutputRenderer;
  private readonly usage: UsageTracker;
  private readonly logger: Logger;
  private readonly guard: PermissionGuard;
  private readonly dispatcher: ToolDispatcher;
  private readonly agentManager: AgentManager;
  private readonly sessionHistory: SessionHistory;

  /** Injected from CLAUDE.md at startup. Empty string if file not found. */
  private readonly projectContext: string;

  /** Current git repository state. Null if not a git repo or git unavailable. */
  private gitContext: GitContext | null = null;

  private context: ContextManager;

  /** Total tool calls in the current user turn. Reset at start of handleInput(). */
  private toolCallsThisTurn = 0;

  constructor(
    config: ResolvedConfig,
    renderer: OutputRenderer,
    usage: UsageTracker,
    agentManager: AgentManager,
    client?: AnthropicClient,
  ) {
    this.config = config;
    this.renderer = renderer;
    this.usage = usage;
    this.agentManager = agentManager;
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

    // Load project context synchronously at construction time.
    const projectResult = loadProjectContextSync(config.workingDirectory);
    this.projectContext = projectResult.content;

    if (projectResult.found) {
      this.logger.info('Project context loaded', {
        path: projectResult.filePath,
        chars: projectResult.content.length,
        truncated: projectResult.truncated,
      });
    } else {
      this.logger.debug('No CLAUDE.md found', { path: projectResult.filePath });
    }

    this.sessionHistory = new SessionHistory();
    this.context = new ContextManager();
  }

  /**
   * Static factory — preferred over `new`.
   * Loads git context, initializes session history, and loads agents.
   */
  static async create(
    config: ResolvedConfig,
    renderer: OutputRenderer,
    usage: UsageTracker,
    client?: AnthropicClient,
  ): Promise<ConversationController> {
    // Build the agent registry and manager.
    const registry = new AgentRegistry();
    await registry.load(config.workingDirectory);
    const agentManager = new AgentManager(registry, config.agent);

    const ctrl = new ConversationController(config, renderer, usage, agentManager, client);
    await ctrl.loadGitContextAsync();
    await ctrl.sessionHistory.init();
    return ctrl;
  }

  private async loadGitContextAsync(): Promise<void> {
    this.gitContext = await loadGitContext(this.config.workingDirectory).catch(() => null);

    if (this.gitContext) {
      this.logger.info('Git context loaded', {
        branch: this.gitContext.branch,
        hasStatus: this.gitContext.status.length > 0,
      });
    } else {
      this.logger.debug('Git context not available', {
        workingDir: this.config.workingDirectory,
      });
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Handle one user turn.
   * Saves session to disk after each turn for crash recovery.
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

    // Save session for crash recovery (best-effort, errors are suppressed).
    await this.sessionHistory
      .save(this.context.snapshot, this.buildSessionStats(), this.activeModel(), this.agentManager.current.name)
      .catch(() => undefined);
  }

  /** Abort the current in-flight API stream (called by SIGINT handler). */
  abort(): void {
    this.client.abort();
  }

  /** Reset conversation history to empty (called by /clear). */
  reset(): void {
    this.context = this.context.reset();
    this.logger.info('Context cleared');
  }

  /** Current turn count (user messages only). */
  get turnCount(): number {
    return this.context.turnCount;
  }

  /** Write the final session record with endedAt. Call on clean exit. */
  async shutdown(): Promise<void> {
    await this.sessionHistory.finalize(
      this.context.snapshot,
      this.buildSessionStats(),
      this.activeModel(),
      this.agentManager.current.name,
    );
  }

  /**
   * Export the current conversation to a Markdown file.
   * Writes to ~/.codeagent/exports/<ISO-timestamp>.md.
   * Returns the file path.
   */
  async exportSession(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const dir = path.join(os.homedir(), '.codeagent', 'exports');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${timestamp}.md`);

    const markdown = SessionExporter.toMarkdown(this.context.snapshot, this.buildSessionStats(), {
      model: this.activeModel(),
      agent: this.agentManager.current.name,
    });

    await fs.writeFile(filePath, markdown, 'utf8');
    return filePath;
  }

  /**
   * Restore conversation history from a previous session (--resume flag).
   * Must be called before the first handleInput().
   */
  restoreMessages(messages: readonly Anthropic.MessageParam[]): void {
    this.context = ContextManager.fromMessages(messages);
  }

  /**
   * Build a CommandContext for the SlashCommandEngine.
   * Called once per REPL line before slash command dispatch.
   */
  getCommandContext(): CommandContext {
    const ctrl = this;

    return {
      get messages() {
        return ctrl.context.snapshot as readonly Anthropic.MessageParam[];
      },
      get activeAgentName() {
        return ctrl.agentManager.current.name;
      },
      get currentModel() {
        return ctrl.activeModel();
      },
      get turnCount() {
        return ctrl.context.turnCount;
      },
      renderer: this.renderer,
      usageTracker: this.usage,

      clearMessages(): void {
        ctrl.reset();
      },

      switchAgent(name: string): Promise<void> {
        try {
          ctrl.agentManager.switchTo(name);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return Promise.resolve();
      },

      listAgents() {
        return ctrl.agentManager.listAll();
      },

      async compact(): Promise<void> {
        ctrl.context = await ctrl.context.forceCompact(
          ctrl.client['client'] as Anthropic,
          ctrl.config.model,
        );
      },

      async exportSession(): Promise<string> {
        return ctrl.exportSession();
      },

      exit(code?: number): never {
        // Fire-and-forget finalize — we're exiting anyway.
        void ctrl.shutdown();
        process.exit(code ?? 0);
      },
    };
  }

  // ── Agentic loop ─────────────────────────────────────────────────────────

  private async runAgenticLoop(): Promise<void> {
    const messages = this.context.snapshot as Anthropic.MessageParam[];
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.activeToolDefinitions();
    const model = this.activeModel();

    const assistantBlocks: Anthropic.ContentBlockParam[] = [];
    const pendingToolCalls: PendingToolCall[] = [];

    this.logger.debug('API stream start', {
      model,
      messageCount: messages.length,
      agent: this.agentManager.current.name,
    });

    for await (const event of this.client.stream(messages, tools, systemPrompt, model)) {
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
          this.usage.record(model, event.inputTokens, event.outputTokens);
          this.logger.debug('Token usage', {
            model,
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

    const mergedAssistantContent = this.mergeTextBlocks(assistantBlocks);
    this.context = this.context.append({
      role: 'assistant',
      content: mergedAssistantContent as Anthropic.MessageParam['content'],
    });

    if (pendingToolCalls.length === 0) return;

    const toolResults: ToolCallResult[] = [];

    try {
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
        toolResults.push(result);
      }
    } catch (dispatchError) {
      // If dispatch throws unexpectedly, synthesise error results for any
      // tool_use blocks that were not yet resolved.  This guarantees the
      // Anthropic API invariant: every tool_use in the assistant message
      // must be immediately followed by a matching tool_result.
      const dispatchedIds = new Set(toolResults.map((r) => r.toolUseId));
      const errMsg =
        dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      this.logger.error('Tool dispatch error', { error: errMsg });
      for (const call of pendingToolCalls) {
        if (!dispatchedIds.has(call.id)) {
          toolResults.push({
            toolUseId: call.id,
            content: `Tool dispatch failed: ${errMsg}`,
            isError: true,
          });
        }
      }
    }

    this.context = this.context.append({
      role: 'user',
      content: toolResults.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      })),
    });

    await this.runAgenticLoop();
  }

  private async dispatchWithPermission(call: PendingToolCall): Promise<ToolCallResult> {
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
      return { toolUseId: call.id, content: `Operation denied by user.`, isError: false };
    }

    const result = await this.dispatcher.dispatch(
      call.name,
      call.input,
      this.config.workingDirectory,
    );
    return { toolUseId: call.id, content: result.content, isError: result.isError };
  }

  // ── Tool filtering ────────────────────────────────────────────────────────

  private activeToolDefinitions() {
    const all = this.dispatcher.allDefinitions();
    const allowlist = this.agentManager.current.tools;
    if (allowlist === undefined) return all;
    const allowed = new Set(allowlist);
    return all.filter((t) => allowed.has(t.name));
  }

  // ── Model resolution ──────────────────────────────────────────────────────

  private activeModel(): string {
    return this.agentManager.current.model ?? this.config.model;
  }

  // ── Session stats ─────────────────────────────────────────────────────────

  private buildSessionStats(): SessionStats {
    const summary = this.usage.summary();
    return {
      startedAt: this.sessionHistory.startedAt,
      turnCount: summary.turnCount,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      estimatedCostUsd: summary.estimatedCostUsd,
      agentsUsed: this.agentManager.agentsUsed(),
    };
  }

  // ── System prompt ─────────────────────────────────────────────────────────

  /**
   * Build the system prompt for this turn.
   *
   * Sections:
   *   1. Working directory + current date
   *   2. Project instructions (CLAUDE.md) — if present
   *   3. Git context — if available
   *   4. Active agent persona
   *   5. Tool constraint note — if agent has a restricted allowlist
   */
  private buildSystemPrompt(): string {
    const sections: string[] = [];
    const agent = this.agentManager.current;

    // Section 1: Working directory and date.
    const date = new Date().toISOString().split('T')[0] ?? '';
    sections.push(`Working directory: ${this.config.workingDirectory}\nToday's date: ${date}`);

    // Section 2: Project instructions from CLAUDE.md.
    if (this.projectContext.trim()) {
      sections.push(`## Project Instructions (CLAUDE.md)\n\n${this.projectContext.trim()}`);
    }

    // Section 3: Git context.
    if (this.gitContext) {
      sections.push(this.formatGitContext(this.gitContext));
    }

    // Section 4: Agent persona.
    sections.push(agent.systemPrompt);

    // Section 5: Tool constraint note.
    if (agent.tools !== undefined) {
      sections.push(
        `Note: In this session you have access only to these tools: ${agent.tools.join(', ')}.`,
      );
    }

    return sections.join('\n\n---\n\n');
  }

  private formatGitContext(ctx: GitContext): string {
    const statusLine = ctx.status.trim() ? ctx.status.trim() : '(clean)';
    const lines = ['## Git Context', '', `Branch: ${ctx.branch}`, `Status: ${statusLine}`];

    if (ctx.diffStat.trim()) {
      lines.push('Recent changes:');
      lines.push(ctx.diffStat.trim());
    }

    return lines.join('\n');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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
