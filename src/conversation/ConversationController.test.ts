import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedConfig } from '../config/types.js';
import { ConversationController } from './ConversationController.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';
import { AnthropicClient, type StreamEvent } from '../api/AnthropicClient.js';
import { AgentManager } from '../agents/AgentManager.js';
import { BUILT_IN_AGENTS } from '../agents/built-in/index.js';
import type { AgentRegistry } from '../agents/AgentRegistry.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return Object.freeze({
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    permissionMode: 'default',
    color: false,
    maxTokens: 8192,
    workingDirectory: '/tmp',
    debug: false,
    maxToolCalls: 25,
    maxOutputChars: 100_000,
    agent: 'default',
    ...overrides,
  });
}

function makeRenderer(): OutputRenderer {
  const r = new OutputRenderer(false, false);
  vi.spyOn(r, 'streamChunk').mockImplementation(() => undefined);
  vi.spyOn(r, 'flush').mockImplementation(() => undefined);
  vi.spyOn(r, 'printError').mockImplementation(() => undefined);
  vi.spyOn(r, 'printToolCall').mockImplementation(() => undefined);
  vi.spyOn(r, 'printToolResult').mockImplementation(() => undefined);
  vi.spyOn(r, 'printInfo').mockImplementation(() => undefined);
  return r;
}

function makeUsage(): UsageTracker {
  return new UsageTracker();
}

/** Build a minimal AgentManager backed by the built-in registry (no I/O). */
function makeAgentManager(initialAgent = 'default'): AgentManager {
  const mockRegistry = {
    resolve: (name: string) => BUILT_IN_AGENTS.find((a) => a.name === name),
    list: () => [...BUILT_IN_AGENTS].sort((a, b) => a.name.localeCompare(b.name)),
  } as unknown as AgentRegistry;
  return new AgentManager(mockRegistry, initialAgent);
}

/** Build a mock AnthropicClient whose stream() yields the given events. */
function makeClient(events: StreamEvent[]): AnthropicClient {
  const client = {
    stream: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    abort: vi.fn(),
    client: { messages: {} }, // accessed via ctrl.client['client'] in compaction
  } as unknown as AnthropicClient;
  return client;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ConversationController', () => {
  let renderer: OutputRenderer;
  let usage: UsageTracker;

  beforeEach(() => {
    renderer = makeRenderer();
    usage = makeUsage();
    vi.clearAllMocks();
  });

  // ── basic turn ──────────────────────────────────────────────────────────────

  it('streams text_delta chunks to renderer', async () => {
    const client = makeClient([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'message_stop' },
    ]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('hi');

    expect(renderer.streamChunk).toHaveBeenCalledWith('Hello');
    expect(renderer.streamChunk).toHaveBeenCalledWith(' world');
  });

  it('calls flush after message_stop', async () => {
    const client = makeClient([
      { type: 'text_delta', text: 'OK' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'message_stop' },
    ]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('hi');

    expect(renderer.flush).toHaveBeenCalled();
  });

  // ── context accumulation ────────────────────────────────────────────────────

  it('turnCount increments after each handleInput call', async () => {
    const client = makeClient([]);
    vi.mocked(client.stream).mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });

    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('turn 1');
    await ctrl.handleInput('turn 2');

    expect(ctrl.turnCount).toBe(2);
  });

  it('passes accumulated messages to client.stream on second turn', async () => {
    const streamFn = vi.fn(async function* () {
      yield { type: 'text_delta', text: 'reply' } as StreamEvent;
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });
    const client = { stream: streamFn, abort: vi.fn(), client: {} } as unknown as AnthropicClient;
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('first');
    await ctrl.handleInput('second');

    const firstCallMessages = (streamFn.mock.calls[0] as unknown[])[0] as unknown[];
    const secondCallMessages = (streamFn.mock.calls[1] as unknown[])[0] as unknown[];
    expect(secondCallMessages.length).toBeGreaterThan(firstCallMessages.length);
  });

  // ── usage recording ─────────────────────────────────────────────────────────

  it('records token usage from usage events', async () => {
    const client = makeClient([
      { type: 'usage', inputTokens: 100, outputTokens: 50 },
      { type: 'message_stop' },
    ]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('hi');

    const totals = usage.totals();
    expect(totals.inputTokens).toBe(100);
    expect(totals.outputTokens).toBe(50);
  });

  it('recordTurn increments usage.turnCount', async () => {
    const client = makeClient([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'message_stop' },
    ]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('hi');

    expect(usage.summary().turnCount).toBe(1);
  });

  // ── error handling ──────────────────────────────────────────────────────────

  it('prints error and stops when stream emits error event', async () => {
    const client = makeClient([
      { type: 'error', message: 'HTTP 401: Unauthorized', retryable: false },
    ]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await ctrl.handleInput('hi');

    expect(renderer.printError).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 401') as unknown,
    );
    expect(renderer.flush).not.toHaveBeenCalled();
  });

  // ── abort ───────────────────────────────────────────────────────────────────

  it('abort() delegates to client.abort()', () => {
    const client = makeClient([]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    ctrl.abort();

    expect(client.abort).toHaveBeenCalledOnce();
  });

  // ── reset ───────────────────────────────────────────────────────────────────

  it('reset() clears context so turnCount returns to 0', async () => {
    const client = makeClient([]);
    vi.mocked(client.stream).mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });

    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);
    await ctrl.handleInput('before clear');

    ctrl.reset();

    expect(ctrl.turnCount).toBe(0);
  });

  // ── tool use ────────────────────────────────────────────────────────────────

  it('acknowledges tool_use events without crashing', async () => {
    const client = makeClient([]);
    let callCount = 0;
    vi.mocked(client.stream).mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'text_delta', text: 'Let me check.' } as StreamEvent;
        yield { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'src/main.ts' } } as StreamEvent;
        yield { type: 'usage', inputTokens: 20, outputTokens: 10 } as StreamEvent;
        yield { type: 'message_stop' } as StreamEvent;
      } else {
        yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
        yield { type: 'message_stop' } as StreamEvent;
      }
    });

    const ctrl = new ConversationController(makeConfig(), renderer, usage, makeAgentManager(), client);

    await expect(ctrl.handleInput('read the main file')).resolves.toBeUndefined();
    expect(renderer.printToolCall).toHaveBeenCalledWith('read_file', { path: 'src/main.ts' });
  });

  // ── system prompt ────────────────────────────────────────────────────────────

  it('includes workingDirectory in the system prompt', async () => {
    const streamFn = vi.fn(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });
    const client = { stream: streamFn, abort: vi.fn(), client: {} } as unknown as AnthropicClient;
    const ctrl = new ConversationController(
      makeConfig({ workingDirectory: '/my/project' }),
      renderer,
      usage,
      makeAgentManager(),
      client,
    );

    await ctrl.handleInput('hello');

    const systemPrompt = (streamFn.mock.calls[0] as unknown[])[2] as string;
    expect(systemPrompt).toContain('/my/project');
  });

  // ── model resolution ─────────────────────────────────────────────────────────

  it('uses config.model when agent has no model override', async () => {
    const streamFn = vi.fn(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });
    const client = { stream: streamFn, abort: vi.fn(), client: {} } as unknown as AnthropicClient;
    const ctrl = new ConversationController(
      makeConfig({ model: 'claude-sonnet-4-6', agent: 'code-reviewer' }),
      renderer,
      usage,
      makeAgentManager('code-reviewer'),
      client,
    );

    await ctrl.handleInput('review this');

    // Built-in agents have no model override — falls back to config.model.
    const modelArg = (streamFn.mock.calls[0] as unknown[])[3] as string;
    expect(modelArg).toBe('claude-sonnet-4-6');
  });

  // ── tool filtering ───────────────────────────────────────────────────────────

  it('passes filtered tools to stream when agent has a tools allowlist', async () => {
    const streamFn = vi.fn(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });
    const client = { stream: streamFn, abort: vi.fn(), client: {} } as unknown as AnthropicClient;
    const ctrl = new ConversationController(
      makeConfig({ agent: 'code-reviewer' }),
      renderer,
      usage,
      makeAgentManager('code-reviewer'),
      client,
    );

    await ctrl.handleInput('review');

    const tools = (streamFn.mock.calls[0] as unknown[])[1] as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    // code-reviewer only has read_file, glob, grep
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('glob');
    expect(toolNames).toContain('grep');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('write_file');
  });
});
