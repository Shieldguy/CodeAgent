import type Anthropic from '@anthropic-ai/sdk';
import type { OutputRenderer } from '../output/OutputRenderer.js';
import type { UsageTracker } from '../output/UsageTracker.js';

/** Minimal agent definition for command context. Expanded in Phase 4. */
export interface AgentDefinition {
  name: string;
  description: string;
  model?: string | undefined;
}

/**
 * The full context passed to every slash command.
 * Commands read session state and trigger mutations through this interface —
 * they never touch controller internals directly.
 */
export interface CommandContext {
  // ── Read-only state ────────────────────────────────────────────────────────
  readonly messages: readonly Anthropic.MessageParam[];
  readonly activeAgentName: string;
  readonly currentModel: string;
  readonly turnCount: number;

  // ── Output ─────────────────────────────────────────────────────────────────
  readonly renderer: OutputRenderer;
  readonly usageTracker: UsageTracker;

  // ── Session mutations ──────────────────────────────────────────────────────
  clearMessages(): void;
  switchAgent(name: string): Promise<void>;
  listAgents(): AgentDefinition[];
  compact(): Promise<void>;
  exportSession(): Promise<string>;
  exit(code?: number): never;
}

/**
 * A single slash command registration.
 */
export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly description: string;
  execute(args: string, ctx: CommandContext): Promise<void>;
}
