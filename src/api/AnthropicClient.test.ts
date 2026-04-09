import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicClient, type StreamEvent } from './AnthropicClient.js';

// ── SDK mock factory ──────────────────────────────────────────────────────────

/**
 * Builds a minimal mock of the Anthropic SDK's streaming response.
 *
 * @param textDeltas  - Array of text strings to yield as content_block_delta events.
 * @param toolUses    - Tool use blocks included in finalMessage().
 * @param usage       - Token usage for finalMessage().
 * @param throwError  - If set, the stream async iterator throws this error immediately.
 */
function makeStreamMock(opts: {
  textDeltas?: string[];
  toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage?: { input_tokens: number; output_tokens: number };
  throwError?: unknown;
}) {
  const textDeltas = opts.textDeltas ?? [];
  const toolUses = opts.toolUses ?? [];
  const usage = opts.usage ?? { input_tokens: 10, output_tokens: 5 };

  // Build the events the async iterator will yield.
  const events: unknown[] = textDeltas.map((text) => ({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  }));

  // Build the finalMessage return value.
  const finalMessage = {
    content: [
      ...textDeltas.map((text) => ({ type: 'text', text })),
      ...toolUses.map((t) => ({ type: 'tool_use', ...t })),
    ],
    usage,
  };

  const asyncIterator = opts.throwError
    ? (async function* () {
        throw opts.throwError;
      })()
    : (async function* () {
        for (const e of events) yield e;
      })();

  return {
    [Symbol.asyncIterator]: () => asyncIterator,
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  };
}

/** Collect all events from the async generator into an array. */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ── Test setup ────────────────────────────────────────────────────────────────

function makeClient(overrides?: { baseURL?: string }) {
  return new AnthropicClient({ apiKey: 'sk-test', ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AnthropicClient.stream', () => {
  let mockStream: ReturnType<typeof makeStreamMock>;

  beforeEach(() => {
    // Reset the SDK constructor mock before each test.
    vi.resetModules();
  });

  it('happy path: yields text_deltas, then tool_use, usage, message_stop', async () => {
    mockStream = makeStreamMock({
      textDeltas: ['Hello', ' world'],
      toolUses: [{ id: 'tu_1', name: 'read_file', input: { path: 'src/main.ts' } }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const client = makeClient();
    // Bypass the real SDK by replacing the internal client's messages.stream.
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(mockStream);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'src/main.ts' } },
      { type: 'usage', inputTokens: 100, outputTokens: 50 },
      { type: 'message_stop' },
    ]);
  });

  it('no tool calls: yields text_deltas, usage, message_stop', async () => {
    mockStream = makeStreamMock({
      textDeltas: ['Just text.'],
      usage: { input_tokens: 20, output_tokens: 10 },
    });

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(mockStream);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    expect(events).toEqual([
      { type: 'text_delta', text: 'Just text.' },
      { type: 'usage', inputTokens: 20, outputTokens: 10 },
      { type: 'message_stop' },
    ]);
  });

  it('multiple tool calls: yields all tool_use events in order', async () => {
    mockStream = makeStreamMock({
      toolUses: [
        { id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
        { id: 'tu_2', name: 'write_file', input: { path: 'b.ts', content: 'x' } },
        { id: 'tu_3', name: 'bash', input: { command: 'ls' } },
      ],
    });

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(mockStream);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));
    const toolEvents = events.filter((e) => e.type === 'tool_use');

    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0]).toMatchObject({ name: 'read_file' });
    expect(toolEvents[1]).toMatchObject({ name: 'write_file' });
    expect(toolEvents[2]).toMatchObject({ name: 'bash' });
  });

  it('tool input is the parsed object, not a JSON string', async () => {
    const deepInput = { nested: { key: [1, 2, 3], flag: true } };
    mockStream = makeStreamMock({
      toolUses: [{ id: 'tu_1', name: 'run', input: deepInput }],
    });

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(mockStream);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));
    const toolEvent = events.find((e) => e.type === 'tool_use');

    expect(toolEvent).toBeDefined();
    if (toolEvent?.type === 'tool_use') {
      expect(toolEvent.input).toEqual(deepInput);
    }
  });

  it('usage event carries correct token counts', async () => {
    mockStream = makeStreamMock({ usage: { input_tokens: 1234, output_tokens: 567 } });

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(mockStream);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));
    const usageEvent = events.find((e) => e.type === 'usage');

    expect(usageEvent).toEqual({ type: 'usage', inputTokens: 1234, outputTokens: 567 });
  });

  it('non-retryable error (401): emits error event immediately, no retry messages', async () => {
    const apiError = Object.assign(new Error('Unauthorized'), { status: 401 });

    const client = makeClient();
    const streamFn = vi.fn().mockRejectedValue(apiError);
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      streamFn;

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    expect(streamFn).toHaveBeenCalledTimes(1); // No retry.
    expect(events).toEqual([
      { type: 'error', message: 'HTTP 401: Unauthorized', retryable: false },
    ]);
  });

  it('non-retryable network error: emits error event, retryable: false', async () => {
    const netError = new Error('ECONNREFUSED');

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockRejectedValue(netError);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    expect(events).toEqual([{ type: 'error', message: 'ECONNREFUSED', retryable: false }]);
  });

  it('retry on 429: emits retry text_delta then succeeds on second attempt', async () => {
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
    const successStream = makeStreamMock({
      textDeltas: ['OK'],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    const client = makeClient();
    const streamFn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(successStream);
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      streamFn;

    // Stub sleep to avoid real delays in tests.
    (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi
      .fn()
      .mockResolvedValue(undefined);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: expect.stringContaining('Rate limited') as unknown });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });

  it('retries exhausted: emits 3 retry text_deltas then error event', async () => {
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });

    const client = makeClient();
    const streamFn = vi.fn().mockRejectedValue(rateLimitError);
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      streamFn;
    (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi
      .fn()
      .mockResolvedValue(undefined);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    const retryMessages = events.filter((e) => e.type === 'text_delta');
    const errorEvent = events.find((e) => e.type === 'error');

    expect(retryMessages).toHaveLength(3); // 3 retry delays before giving up.
    expect(errorEvent).toMatchObject({ type: 'error', retryable: true });
    expect(streamFn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('abort during stream: generator returns silently', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const abortingStream = makeStreamMock({ throwError: abortError });

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(abortingStream);

    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    expect(events).toHaveLength(0); // No events emitted after abort.
  });

  it('abort() resets controller so next stream() works cleanly', async () => {
    mockStream = makeStreamMock({ textDeltas: ['hi'] });

    const client = makeClient();
    (client as unknown as { client: { messages: { stream: unknown } } }).client.messages.stream =
      vi.fn().mockResolvedValue(mockStream);

    client.abort(); // Abort before any stream starts.
    const events = await collectEvents(client.stream([], [], 'system', 'claude-sonnet-4-6'));

    // The abort controller is reset inside stream() — the stream should succeed.
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });
});
