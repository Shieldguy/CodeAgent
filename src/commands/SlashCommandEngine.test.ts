import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlashCommandEngine } from './SlashCommandEngine.js';
import type { CommandContext } from './types.js';
import type { OutputRenderer } from '../output/OutputRenderer.js';
import type { UsageTracker } from '../output/UsageTracker.js';
import type Anthropic from '@anthropic-ai/sdk';

function makeRenderer(): OutputRenderer {
  return {
    print: vi.fn(),
    printInfo: vi.fn(),
    printError: vi.fn(),
    streamChunk: vi.fn(),
    flush: vi.fn(),
    printToolCall: vi.fn(),
    printToolResult: vi.fn(),
    printWelcome: vi.fn(),
  } as unknown as OutputRenderer;
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [] as readonly Anthropic.MessageParam[],
    activeAgentName: 'default',
    currentModel: 'claude-sonnet-4-6',
    turnCount: 0,
    renderer: makeRenderer(),
    usageTracker: {
      summary: vi.fn().mockReturnValue({ turnCount: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0 }),
      formatSummary: vi.fn().mockReturnValue('No API calls recorded this session.'),
    } as unknown as UsageTracker,
    clearMessages: vi.fn(),
    switchAgent: vi.fn().mockResolvedValue(undefined),
    listAgents: vi.fn().mockReturnValue([{ name: 'default', description: 'Default' }]),
    compact: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue('/tmp/export.md'),
    exit: vi.fn() as unknown as CommandContext['exit'],
    ...overrides,
  };
}

describe('SlashCommandEngine', () => {
  let engine: SlashCommandEngine;

  beforeEach(() => {
    engine = new SlashCommandEngine();
  });

  // ── dispatch routing ────────────────────────────────────────────────────────

  it('returns false for non-slash input', async () => {
    const handled = await engine.execute('hello world', makeCtx());
    expect(handled).toBe(false);
  });

  it('returns true for a known slash command', async () => {
    const handled = await engine.execute('/help', makeCtx());
    expect(handled).toBe(true);
  });

  it('returns true and prints error for an unknown command', async () => {
    const ctx = makeCtx();
    const handled = await engine.execute('/nonexistent', ctx);
    expect(handled).toBe(true);
    expect(ctx.renderer.printError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command') as string,
    );
  });

  it('is case-insensitive for command names', async () => {
    const ctx = makeCtx();
    await engine.execute('/CLEAR', ctx);
    expect(ctx.clearMessages).toHaveBeenCalled();
  });

  // ── aliases ─────────────────────────────────────────────────────────────────

  it('/q alias triggers exit', async () => {
    const ctx = makeCtx();
    await engine.execute('/q', ctx);
    expect(ctx.exit).toHaveBeenCalled();
  });

  it('/quit alias triggers exit', async () => {
    const ctx = makeCtx();
    await engine.execute('/quit', ctx);
    expect(ctx.exit).toHaveBeenCalled();
  });

  it('/? alias triggers help', async () => {
    const ctx = makeCtx();
    await engine.execute('/?', ctx);
    expect(ctx.renderer.print).toHaveBeenCalledWith(
      expect.stringContaining('clear') as string,
    );
  });

  // ── built-in commands ───────────────────────────────────────────────────────

  it('/clear calls clearMessages and prints confirmation', async () => {
    const ctx = makeCtx({
      messages: [{} as Anthropic.MessageParam, {} as Anthropic.MessageParam],
    });
    await engine.execute('/clear', ctx);
    expect(ctx.clearMessages).toHaveBeenCalled();
    expect(ctx.renderer.printInfo).toHaveBeenCalledWith(
      expect.stringContaining('2 messages removed') as string,
    );
  });

  it('/help lists all commands', async () => {
    const ctx = makeCtx();
    await engine.execute('/help', ctx);
    expect(ctx.renderer.print).toHaveBeenCalledWith(
      expect.stringContaining('clear') as string,
    );
    expect(ctx.renderer.print).toHaveBeenCalledWith(
      expect.stringContaining('exit') as string,
    );
  });

  it('/usage prints usage summary', async () => {
    const ctx = makeCtx();
    await engine.execute('/usage', ctx);
    expect(ctx.usageTracker.formatSummary).toHaveBeenCalled();
    expect(ctx.renderer.print).toHaveBeenCalled();
  });

  it('/export calls exportSession and prints file path', async () => {
    const ctx = makeCtx();
    await engine.execute('/export', ctx);
    expect(ctx.exportSession).toHaveBeenCalled();
    expect(ctx.renderer.printInfo).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/export.md') as string,
    );
  });

  it('/compact calls compact and shows before/after count', async () => {
    const ctx = makeCtx({
      messages: new Array(10).fill({}) as Anthropic.MessageParam[],
    });
    await engine.execute('/compact', ctx);
    expect(ctx.compact).toHaveBeenCalled();
  });

  it('/agent with no args calls listAgents', async () => {
    const ctx = makeCtx();
    await engine.execute('/agent', ctx);
    expect(ctx.listAgents).toHaveBeenCalled();
    expect(ctx.switchAgent).not.toHaveBeenCalled();
  });

  it('/agent <name> calls switchAgent with the name', async () => {
    const ctx = makeCtx();
    await engine.execute('/agent code-reviewer', ctx);
    expect(ctx.switchAgent).toHaveBeenCalledWith('code-reviewer');
  });

  it('/info prints session info', async () => {
    const ctx = makeCtx({ turnCount: 3 });
    await engine.execute('/info', ctx);
    expect(ctx.renderer.print).toHaveBeenCalledWith(
      expect.stringContaining('Session Info') as string,
    );
  });

  // ── custom command registration ─────────────────────────────────────────────

  it('custom registered command overwrites built-in with same name', async () => {
    const custom = { name: 'clear', description: 'custom clear', execute: vi.fn() };
    engine.register(custom);
    const ctx = makeCtx();
    await engine.execute('/clear', ctx);
    expect(custom.execute).toHaveBeenCalled();
    expect(ctx.clearMessages).not.toHaveBeenCalled();
  });

  // ── argument passing ────────────────────────────────────────────────────────

  it('passes arguments to the command', async () => {
    const ctx = makeCtx();
    await engine.execute('/agent my-agent', ctx);
    expect(ctx.switchAgent).toHaveBeenCalledWith('my-agent');
  });

  // ── listCommands() ──────────────────────────────────────────────────────────

  it('listCommands returns sorted commands without duplicates', () => {
    const commands = engine.listCommands();
    const names = commands.map((c) => c.name);
    expect(names).toEqual([...names].sort());
    // No duplicates.
    expect(new Set(names).size).toBe(names.length);
    // Core commands present.
    expect(names).toContain('clear');
    expect(names).toContain('exit');
    expect(names).toContain('help');
  });
});
