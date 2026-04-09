import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedConfig } from '../config/types.js';
import { ConversationController } from './ConversationController.js';
import { OutputRenderer } from '../output/OutputRenderer.js';
import { UsageTracker } from '../output/UsageTracker.js';
import { AnthropicClient, type StreamEvent } from '../api/AnthropicClient.js';

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

/** Build a mock AnthropicClient whose stream() yields the given events. */
function makeClient(events: StreamEvent[]): AnthropicClient {
  const client = {
    stream: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    abort: vi.fn(),
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
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

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
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

    await ctrl.handleInput('hi');

    expect(renderer.flush).toHaveBeenCalled();
  });

  // ── context accumulation ────────────────────────────────────────────────────

  it('turnCount increments after each handleInput call', async () => {
    const client = makeClient([
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'message_stop' },
    ]);
    // Need a fresh stream each call since generators are single-use.
    vi.mocked(client.stream).mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
      yield { type: 'message_stop' };
    });

    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

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
    const client = { stream: streamFn, abort: vi.fn() } as unknown as AnthropicClient;
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

    await ctrl.handleInput('first');
    await ctrl.handleInput('second');

    // Second call should have more messages than the first.
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
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

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
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

    await ctrl.handleInput('hi');

    expect(usage.summary().turnCount).toBe(1);
  });

  // ── error handling ──────────────────────────────────────────────────────────

  it('prints error and stops when stream emits error event', async () => {
    const client = makeClient([
      { type: 'error', message: 'HTTP 401: Unauthorized', retryable: false },
    ]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

    await ctrl.handleInput('hi');

    expect(renderer.printError).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 401') as unknown,
    );
    // No flush should have been called since stream terminated early.
    expect(renderer.flush).not.toHaveBeenCalled();
  });

  // ── abort ───────────────────────────────────────────────────────────────────

  it('abort() delegates to client.abort()', () => {
    const client = makeClient([]);
    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

    ctrl.abort();

    expect(client.abort).toHaveBeenCalledOnce();
  });

  // ── reset ───────────────────────────────────────────────────────────────────

  it('reset() clears context so turnCount returns to 0', async () => {
    const client = makeClient([
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'message_stop' },
    ]);
    vi.mocked(client.stream).mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });

    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);
    await ctrl.handleInput('before clear');

    ctrl.reset();

    expect(ctrl.turnCount).toBe(0);
  });

  // ── tool use (Phase 1 stub) ──────────────────────────────────────────────────

  it('acknowledges tool_use events without crashing (Phase 1 stub)', async () => {
    const client = makeClient([
      { type: 'text_delta', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'read_file',
        input: { path: 'src/main.ts' },
      },
      { type: 'usage', inputTokens: 20, outputTokens: 10 },
      { type: 'message_stop' },
    ]);

    // Second stream call (after tool result appended) should just return stop.
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

    const ctrl = new ConversationController(makeConfig(), renderer, usage, client);

    // Should not throw.
    await expect(ctrl.handleInput('read the main file')).resolves.toBeUndefined();
    expect(renderer.printToolCall).toHaveBeenCalledWith('read_file', { path: 'src/main.ts' });
  });

  // ── system prompt ────────────────────────────────────────────────────────────

  it('includes workingDirectory in the system prompt', async () => {
    const streamFn = vi.fn(async function* () {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as StreamEvent;
      yield { type: 'message_stop' } as StreamEvent;
    });
    const client = { stream: streamFn, abort: vi.fn() } as unknown as AnthropicClient;
    const ctrl = new ConversationController(
      makeConfig({ workingDirectory: '/my/project' }),
      renderer,
      usage,
      client,
    );

    await ctrl.handleInput('hello');

    const systemPrompt = (streamFn.mock.calls[0] as unknown[])[2] as string;
    expect(systemPrompt).toContain('/my/project');
  });
});
