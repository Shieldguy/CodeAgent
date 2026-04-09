# DESIGN_F2 — Anthropic API Streaming Client & Retry with Backoff

> Features: F2 (Anthropic API streaming), F19 (Retry with exponential backoff)

---

## 1. Purpose & Scope

This document covers `src/api/AnthropicClient.ts` — the single module responsible for all
communication with the Anthropic API.

Responsibilities:
- Open an SSE streaming connection for every turn.
- Yield a discriminated-union `StreamEvent` sequence to the caller.
- Assemble complete `tool_use` inputs from `finalMessage()` (not from `input_json_delta`).
- Extract token usage from `finalMessage()` and yield it as a `usage` event.
- Abort a stream mid-flight on `controller.abort()`.
- Retry on HTTP 429 / 529 with exponential backoff (max 3 attempts).
- Emit a `text_delta` event during retry wait periods so the REPL can show progress.

Non-goals:
- Does not maintain conversation history (`messages[]` lives in `ContextManager`).
- Does not decide which model or tools to use (passed in per-call by `ConversationController`).
- Does not render output (that is `OutputRenderer`'s job).

---

## 2. File: `src/api/AnthropicClient.ts`

### 2.1 StreamEvent Discriminated Union

Every event the client emits belongs to this union. The caller pattern-matches on `type`.

```typescript
// src/api/AnthropicClient.ts

import Anthropic from '@anthropic-ai/sdk';

/** A single streamed text chunk from the model. */
export interface TextDeltaEvent {
  type: 'text_delta';
  text: string;
}

/**
 * A complete tool call, assembled after message_stop.
 * The `input` field is always a fully parsed object — never a partial string.
 */
export interface ToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Token counts extracted from the final message. Emitted once per stream. */
export interface UsageEvent {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
}

/**
 * Emitted when the stream ends cleanly with no tool calls.
 * Signals the agentic loop to stop recursing.
 */
export interface MessageStopEvent {
  type: 'message_stop';
}

/**
 * Emitted when a non-retryable error occurs, or retries are exhausted.
 * The stream terminates after this event.
 */
export interface StreamErrorEvent {
  type: 'error';
  message: string;
  retryable: boolean;
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolUseEvent
  | UsageEvent
  | MessageStopEvent
  | StreamErrorEvent;
```

**Design rationale for the union:**
- Using a discriminated union on `type` lets the caller use a `switch` statement with
  exhaustiveness checking.
- `tool_use` events carry a fully parsed `input` (not a streaming delta accumulation).
  The caller never has to reassemble JSON from partial strings.
- `error` carries `retryable` so callers can decide whether to show "retrying..." UI.

---

### 2.2 `AnthropicClient` Class

```typescript
// src/api/AnthropicClient.ts (continued)

export interface AnthropicClientConfig {
  apiKey: string;
  /** Base URL override for testing or proxying. */
  baseURL?: string;
  /** Default timeout per request in milliseconds. Default: 120_000 (2 min). */
  timeoutMs?: number;
}

/**
 * Wraps the official Anthropic SDK to provide:
 *   - An async generator stream API
 *   - Abort support
 *   - Retry with backoff (F19)
 *   - Complete tool_use input assembly
 *   - Token usage extraction
 *
 * One instance is created per session and shared across all turns.
 * The model is passed per-call (not in the constructor) to support agent model overrides.
 */
export class AnthropicClient {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private abortController: AbortController;

  /** Retryable HTTP status codes. */
  private static readonly RETRYABLE_STATUS = new Set([429, 529]);
  /** Maximum number of retry attempts. */
  private static readonly MAX_RETRIES = 3;
  /** Base delay in milliseconds for exponential backoff. */
  private static readonly BASE_DELAY_MS = 1_000;

  constructor(config: AnthropicClientConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.abortController = new AbortController();
  }

  /**
   * Abort the current in-flight stream.
   * Safe to call even when no stream is active.
   * The next call to stream() automatically creates a fresh AbortController.
   */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Stream a single API request.
   * Returns an async generator of StreamEvents.
   *
   * The model is supplied per-call to support agent-level model overrides
   * without requiring a new client instance.
   */
  async *stream(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    systemPrompt: string,
    model: string
  ): AsyncGenerator<StreamEvent> {
    // Reset abort controller for each new stream.
    this.abortController = new AbortController();

    yield* this.streamWithRetry(messages, tools, systemPrompt, model);
  }

  // ── Private implementation ─────────────────────────────────────────────────

  /**
   * Outer retry loop.
   * On a retryable status code, emits a text_delta with a "retrying…" message,
   * waits for the backoff duration, then tries again.
   */
  private async *streamWithRetry(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    systemPrompt: string,
    model: string
  ): AsyncGenerator<StreamEvent> {
    let attempt = 0;

    while (attempt <= AnthropicClient.MAX_RETRIES) {
      try {
        yield* this.streamOnce(messages, tools, systemPrompt, model);
        return; // Success — stop retrying.
      } catch (error: unknown) {
        // Abort is a clean cancellation — swallow silently and stop.
        if (this.isAbortError(error)) {
          return;
        }

        const status = this.extractStatus(error);
        const isRetryable = status !== undefined && AnthropicClient.RETRYABLE_STATUS.has(status);

        if (!isRetryable || attempt >= AnthropicClient.MAX_RETRIES) {
          yield {
            type: 'error',
            message: this.formatError(error, status),
            retryable: isRetryable,
          };
          return;
        }

        // Compute backoff delay: 1s, 2s, 4s.
        const delayMs = AnthropicClient.BASE_DELAY_MS * Math.pow(2, attempt);
        const delaySeconds = delayMs / 1_000;
        attempt++;

        // Emit a progress text_delta so the UI can show feedback during the wait.
        yield {
          type: 'text_delta',
          text: `\n[Rate limited — retrying in ${delaySeconds}s (attempt ${attempt}/${AnthropicClient.MAX_RETRIES})…]\n`,
        };

        await this.sleep(delayMs);
      }
    }
  }

  /**
   * Single streaming attempt to the Anthropic API.
   * Throws on network/API errors.
   * Yields events from the SDK's SSE stream.
   *
   * Why finalMessage() instead of input_json_delta accumulation:
   *   input_json_delta events carry partial JSON strings that must be
   *   concatenated and then parsed. This is error-prone (malformed UTF-8
   *   split across deltas, edge cases in deeply nested objects).
   *   The SDK's finalMessage() returns the fully parsed message object
   *   including complete tool_use blocks with already-parsed `input` fields.
   *   We use streaming only for text_delta events (live display) and rely
   *   on finalMessage() for everything that requires the complete picture.
   */
  private async *streamOnce(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    systemPrompt: string,
    model: string
  ): AsyncGenerator<StreamEvent> {
    const stream = await this.client.messages.stream(
      {
        model,
        max_tokens: 8_096,
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      },
      {
        signal: this.abortController.signal,
        timeout: this.timeoutMs,
      }
    );

    // Stream text deltas live so the terminal shows the response as it arrives.
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield {
          type: 'text_delta',
          text: event.delta.text,
        };
      }
      // We intentionally skip input_json_delta events here.
      // Tool inputs are assembled from finalMessage() after the stream ends.
    }

    // After the stream ends, retrieve the complete final message.
    const finalMsg = await stream.finalMessage();

    // Extract and yield complete tool_use blocks.
    for (const block of finalMsg.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          // block.input is already a parsed Record<string, unknown> from the SDK.
          input: block.input as Record<string, unknown>,
        };
      }
    }

    // Yield token usage.
    yield {
      type: 'usage',
      inputTokens: finalMsg.usage.input_tokens,
      outputTokens: finalMsg.usage.output_tokens,
    };

    // Signal that the model has finished this turn.
    yield {
      type: 'message_stop',
    };
  }

  // ── Utility helpers ────────────────────────────────────────────────────────

  private isAbortError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'))
    );
  }

  private extractStatus(error: unknown): number | undefined {
    if (
      error !== null &&
      typeof error === 'object' &&
      'status' in error &&
      typeof (error as Record<string, unknown>).status === 'number'
    ) {
      return (error as { status: number }).status;
    }
    return undefined;
  }

  private formatError(error: unknown, status: number | undefined): string {
    const base = error instanceof Error ? error.message : String(error);
    return status !== undefined ? `HTTP ${status}: ${base}` : base;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

---

## 3. Why `finalMessage()` Instead of `input_json_delta` Accumulation

The Anthropic SDK emits `input_json_delta` events that carry partial JSON strings for tool
inputs. A naive approach would accumulate these strings and then call `JSON.parse()` at the
end. This approach has several failure modes:

1. **UTF-8 boundary splits:** a multi-byte character can be split across two delta events,
   producing an invalid string if you concatenate raw buffers.
2. **Edge cases in nested objects:** deeply nested structures accumulate correctly as strings
   but the concatenation order must be maintained precisely.
3. **Error recovery:** if one delta is missing, the accumulated string is unparseable and
   the tool call is silently lost.

The SDK's `finalMessage()` method waits for the stream to complete and returns the fully
deserialized message with `tool_use.input` already parsed into a JavaScript object. This is
the intended usage pattern. We sacrifice the ability to show tool inputs as they stream
(which would be noisy anyway) in exchange for reliability.

**Live display tradeoff:** We still stream `text_delta` events live for assistant text so
the user sees the response appearing in real time. Only tool call inputs use `finalMessage()`.

---

## 4. Retry Strategy (F19)

### 4.1 Which Errors Are Retryable

| HTTP Status | Meaning | Retryable? |
|-------------|---------|-----------|
| 429 | Too Many Requests (rate limit) | Yes |
| 529 | API overloaded | Yes |
| 401 | Unauthorized (bad API key) | No |
| 400 | Bad Request (invalid payload) | No |
| 500 | Internal Server Error | No |
| Network error | Connection refused, timeout | No |

Only 429 and 529 indicate transient server-side conditions where retrying is appropriate.
500 errors indicate a bug in the request payload; retrying will not help.

### 4.2 Backoff Schedule

| Attempt | Delay Before This Attempt |
|---------|--------------------------|
| 1st (initial) | 0ms |
| 2nd | 1000ms |
| 3rd | 2000ms |
| 4th (final) | 4000ms |
| Exhausted | Emit `error` event |

Formula: `delay = BASE_DELAY_MS * 2^(attempt - 1)` where `attempt` starts at 1 for the
first retry.

### 4.3 Progress Text During Wait

During each retry wait, a `text_delta` event is emitted:

```
[Rate limited — retrying in 2s (attempt 2/3)…]
```

This ensures the user is not staring at a frozen terminal. The `OutputRenderer` renders
this text in a dimmed style to distinguish it from model output.

### 4.4 Abort During Retry Wait

If `abort()` is called while `sleep()` is in progress, the sleep resolves normally (we do
not cancel timers). On the next loop iteration, `streamOnce()` is called with an already-
aborted `AbortController`, which causes the SDK to throw an `AbortError` immediately. The
`isAbortError()` check catches this and the generator returns silently.

This means abort during a retry wait takes at most `BASE_DELAY_MS * 2^attempt` milliseconds
to respond. This is acceptable; a 4-second maximum is within user expectations.

---

## 5. Abort Behavior

```typescript
// In ConversationController:
controller.abort() → client.abort() → abortController.abort()

// In streamOnce():
stream = client.messages.stream({ signal: abortController.signal, ... })
// When signal fires, the SDK throws AbortError.

// In streamWithRetry():
if (this.isAbortError(error)) {
  return; // Silent exit — no error event emitted.
}
```

The `abort()` method replaces the `abortController` on the **next** call to `stream()`.
This means calling `abort()` twice in a row is safe — the second call aborts the current
controller (which may already be aborted), and the next `stream()` call creates a fresh one.

---

## 6. Test Cases (Mock the Anthropic SDK)

### 6.1 Happy Path

```typescript
// Mock: stream emits 2 text_deltas, then stops with 1 tool_use and usage stats.
// Expected events:
//   { type: 'text_delta', text: 'Hello' }
//   { type: 'text_delta', text: ' world' }
//   { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'src/main.ts' } }
//   { type: 'usage', inputTokens: 100, outputTokens: 50 }
//   { type: 'message_stop' }
```

### 6.2 No Tool Calls

```typescript
// Mock: finalMessage has only text content, no tool_use blocks.
// Expected: text_deltas + usage + message_stop (no tool_use events).
```

### 6.3 Retry on 429

```typescript
// Mock: first call throws { status: 429 }, second call succeeds.
// Expected:
//   { type: 'text_delta', text: '[Rate limited — retrying in 1s (attempt 1/3)…]\n' }
//   // After delay: normal events from second call.
```

### 6.4 Retry Exhausted

```typescript
// Mock: all 4 calls (initial + 3 retries) throw { status: 429 }.
// Expected:
//   3x text_delta with retry messages
//   { type: 'error', message: 'HTTP 429: ...', retryable: true }
//   // Generator stops; no message_stop.
```

### 6.5 Non-Retryable Error

```typescript
// Mock: call throws { status: 401, message: 'Unauthorized' }.
// Expected:
//   { type: 'error', message: 'HTTP 401: Unauthorized', retryable: false }
//   // No retry; no text_delta progress message.
```

### 6.6 Abort During Stream

```typescript
// Mock: stream is in progress (async iterator is paused).
// Call client.abort() from a separate promise.
// Expected: generator returns with no events after the abort.
```

### 6.7 Tool Input Completeness

```typescript
// Mock: finalMessage returns tool_use with deeply nested input object.
// Expected: tool_use event carries the same object, exactly parsed.
// Validates that we did NOT manually parse any JSON strings.
```

### 6.8 Multiple Tool Calls in One Response

```typescript
// Mock: finalMessage has 3 tool_use blocks.
// Expected: 3 separate tool_use events, in order, then usage, then message_stop.
```

### 6.9 Token Usage Extraction

```typescript
// Mock: finalMessage.usage = { input_tokens: 1234, output_tokens: 567 }
// Expected: { type: 'usage', inputTokens: 1234, outputTokens: 567 }
```
