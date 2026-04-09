import Anthropic from '@anthropic-ai/sdk';

// ── StreamEvent discriminated union ───────────────────────────────────────────

/** A single streamed text chunk from the model. */
export interface TextDeltaEvent {
  type: 'text_delta';
  text: string;
}

/**
 * A complete tool call, assembled after message_stop.
 * `input` is always a fully parsed object — never a partial JSON string.
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
 * Emitted when the stream ends cleanly.
 * Signals the agentic loop that no further tool dispatch is needed.
 */
export interface MessageStopEvent {
  type: 'message_stop';
}

/**
 * Emitted when a non-retryable error occurs, or retries are exhausted.
 * The generator terminates after this event.
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

// ── AnthropicClient ───────────────────────────────────────────────────────────

export interface AnthropicClientConfig {
  apiKey: string;
  /** Base URL override for testing or proxying. */
  baseURL?: string | undefined;
  /** Per-request timeout in milliseconds. Default: 120_000 (2 min). */
  timeoutMs?: number | undefined;
}

/**
 * Thin wrapper around the official Anthropic SDK that provides:
 *   - Async-generator stream API (yields StreamEvent)
 *   - Abort support (Ctrl+C stops the stream without killing the process)
 *   - Retry with exponential backoff for HTTP 429 / 529 (F19)
 *   - Complete tool_use input assembly via finalMessage()
 *   - Token usage extraction
 *
 * One instance is created per session and reused across all turns.
 * The model is passed per-call to support agent-level model overrides.
 */
export class AnthropicClient {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private abortController: AbortController;

  private static readonly RETRYABLE_STATUS = new Set([429, 529]);
  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_DELAY_MS = 1_000;

  constructor(config: AnthropicClientConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      // Disable the SDK's built-in retry so we control it ourselves.
      maxRetries: 0,
    });
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.abortController = new AbortController();
  }

  /**
   * Abort the current in-flight stream.
   * Safe to call when no stream is active.
   * The next stream() call automatically creates a fresh AbortController.
   */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Stream a single API turn.
   *
   * @param messages - Full conversation history (MessageParam[]).
   * @param tools    - Tool definitions available this turn.
   * @param systemPrompt - Composed system prompt for this turn.
   * @param model    - Model ID (e.g. "claude-sonnet-4-6").
   *
   * Yields StreamEvents in this order:
   *   text_delta*  →  tool_use*  →  usage  →  message_stop
   *         (or: error — then generator stops)
   */
  async *stream(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    systemPrompt: string,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    // Fresh abort controller for each new stream so a previous abort does not
    // poison the next turn.
    this.abortController = new AbortController();
    yield* this.streamWithRetry(messages, tools, systemPrompt, model);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async *streamWithRetry(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    systemPrompt: string,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    let attempt = 0;

    while (attempt <= AnthropicClient.MAX_RETRIES) {
      try {
        yield* this.streamOnce(messages, tools, systemPrompt, model);
        return;
      } catch (error: unknown) {
        // Ctrl+C / abort() — silent exit, no error event.
        if (this.isAbortError(error)) {
          return;
        }

        const status = this.extractStatus(error);
        const isRetryable =
          status !== undefined && AnthropicClient.RETRYABLE_STATUS.has(status);

        if (!isRetryable || attempt >= AnthropicClient.MAX_RETRIES) {
          yield {
            type: 'error',
            message: this.formatError(error, status),
            retryable: isRetryable,
          };
          return;
        }

        // Backoff: 1s → 2s → 4s
        const delayMs = AnthropicClient.BASE_DELAY_MS * Math.pow(2, attempt);
        attempt++;

        yield {
          type: 'text_delta',
          text: `\n[Rate limited — retrying in ${delayMs / 1_000}s (attempt ${attempt}/${AnthropicClient.MAX_RETRIES})…]\n`,
        };

        await this.sleep(delayMs);
      }
    }
  }

  /**
   * Single streaming attempt.
   *
   * Text deltas are yielded live (for real-time display).
   * Tool inputs are assembled from finalMessage() — not from input_json_delta —
   * because the SDK already parses and validates the complete tool input object.
   */
  private async *streamOnce(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    systemPrompt: string,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    const baseParams = {
      model,
      max_tokens: 8_096,
      system: systemPrompt,
      messages,
    };
    const params =
      tools.length > 0 ? { ...baseParams, tools } : baseParams;

    const stream = await this.client.messages.stream(
      params,
      {
        signal: this.abortController.signal,
        timeout: this.timeoutMs,
      },
    );

    // Yield text deltas live so the terminal renders text as it arrives.
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text_delta', text: event.delta.text };
      }
      // input_json_delta events are intentionally skipped here; see finalMessage() below.
    }

    // Retrieve the fully assembled message (tool inputs are already parsed objects).
    const finalMsg = await stream.finalMessage();

    for (const block of finalMsg.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
    }

    yield {
      type: 'usage',
      inputTokens: finalMsg.usage.input_tokens,
      outputTokens: finalMsg.usage.output_tokens,
    };

    yield { type: 'message_stop' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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
      typeof (error as Record<string, unknown>)['status'] === 'number'
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
