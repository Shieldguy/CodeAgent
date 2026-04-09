import type Anthropic from '@anthropic-ai/sdk';
import { summarizeMessages } from './Compactor.js';

/** 1 token ≈ 4 characters. Heuristic accurate to ±20% for English text. */
const CHARS_PER_TOKEN = 4;

/**
 * Token threshold at which compaction is triggered.
 * 150 000 tokens × 4 chars/token = 600 000 characters.
 * Leaves headroom for the system prompt and tool definitions.
 */
const COMPACTION_THRESHOLD_TOKENS = 150_000;

/** Number of most-recent messages kept verbatim during compaction. */
const VERBATIM_TAIL_COUNT = 20;

/**
 * ContextManager holds the ordered conversation message array.
 *
 * Immutable: every method that changes state returns a new instance.
 * The caller (ConversationController) reassigns its reference each turn:
 *   this.context = this.context.append(msg);
 */
export class ContextManager {
  private readonly messages: ReadonlyArray<Anthropic.MessageParam>;

  constructor(messages: ReadonlyArray<Anthropic.MessageParam> = []) {
    this.messages = messages;
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  /**
   * Number of user-role turns in the conversation.
   * Used for `/info` display and session stats.
   */
  get turnCount(): number {
    return this.messages.filter((m) => m.role === 'user').length;
  }

  /**
   * Snapshot of the current messages array (defensive copy).
   * Callers may not mutate the returned array or its elements.
   */
  get snapshot(): ReadonlyArray<Anthropic.MessageParam> {
    return [...this.messages];
  }

  /**
   * Estimated token count of all messages.
   * Uses character-count heuristic: chars / CHARS_PER_TOKEN.
   */
  get estimatedTokenCount(): number {
    let totalChars = 0;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block && typeof block.text === 'string') {
            totalChars += block.text.length;
          }
        }
      }
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  // ── State transitions ────────────────────────────────────────────────────────

  /**
   * Append a message. Returns a new ContextManager — the original is unchanged.
   */
  append(message: Anthropic.MessageParam): ContextManager {
    return new ContextManager([...this.messages, message]);
  }

  /**
   * Reset to an empty conversation. Used by /clear.
   */
  reset(): ContextManager {
    return new ContextManager([]);
  }

  // ── Compaction (F12, F27) ────────────────────────────────────────────────────

  /**
   * Compact the conversation if the estimated token count exceeds the threshold.
   *
   * Returns `this` (same instance) when compaction is not needed — no allocation.
   * Returns a new ContextManager with a summary prefix when compaction runs.
   *
   * @param client - Anthropic SDK client passed through from ConversationController.
   * @param model  - Model ID to use for summarization.
   */
  async maybeCompactAsync(client: Anthropic, model: string): Promise<ContextManager> {
    if (this.estimatedTokenCount <= COMPACTION_THRESHOLD_TOKENS) {
      return this;
    }
    return this.compact(client, model);
  }

  /**
   * Compact: summarize old messages, keep the recent tail verbatim.
   *
   * Strategy:
   *   1. Keep the last VERBATIM_TAIL_COUNT messages exactly as-is.
   *   2. Summarize all older messages via Compactor.
   *   3. Return [summaryMessage, acknowledgment, ...tailMessages].
   *
   * The summary is injected as a user-role message so the model sees it as
   * context. An assistant acknowledgment follows to maintain role alternation.
   */
  private async compact(client: Anthropic, model: string): Promise<ContextManager> {
    const total = this.messages.length;

    if (total <= VERBATIM_TAIL_COUNT) {
      // Cannot meaningfully summarize fewer messages than the verbatim tail.
      return this;
    }

    const oldMessages = this.messages.slice(0, total - VERBATIM_TAIL_COUNT);
    const tailMessages = this.messages.slice(total - VERBATIM_TAIL_COUNT);

    let summaryText: string;
    try {
      summaryText = await summarizeMessages(client, model, [...oldMessages]);
    } catch (error) {
      // Keep the session alive if summarization fails.
      summaryText =
        `[Context summary unavailable: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `${oldMessages.length} messages were omitted.]`;
    }

    const summaryMessage: Anthropic.MessageParam = {
      role: 'user',
      content:
        `[CONTEXT SUMMARY — Automatically generated to preserve context within the ` +
        `token limit.]\n\n${summaryText}`,
    };

    // Maintain user → assistant → user alternation.
    const acknowledgment: Anthropic.MessageParam = {
      role: 'assistant',
      content: '[Context summary received. Continuing from the summary.]',
    };

    return new ContextManager([summaryMessage, acknowledgment, ...tailMessages]);
  }
}
