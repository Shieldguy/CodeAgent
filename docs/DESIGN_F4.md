# DESIGN_F4 — Conversation Context Manager, Compaction, Smart Compaction

> Features: F4 (Context Manager), F12 (Multi-turn memory compaction), F27 (Smart compaction via summarization API)

---

## 1. Purpose & Scope

This document covers how CodeAgent stores, appends, and compacts the conversation history
across turns.

| Feature | Description |
|---------|-------------|
| F4 | `ContextManager` — immutable message array with append and reset |
| F12 | Token estimation and compaction trigger |
| F27 | Smart compaction: API-based summarization of old messages |

### Key invariant

Every API call receives the **full accumulated conversation history**. The messages array
is never trimmed except by explicit compaction. This preserves coherence across long sessions.

### Non-goals

- This module does not call the Anthropic API for normal turns (that is `ConversationController`).
- It does not render output.
- It does not track token usage for cost display (that is `UsageTracker`).

---

## 2. File Structure

```
src/conversation/
  ContextManager.ts     # Immutable message array + compaction trigger (F4, F12)
  Compactor.ts          # API-based summarization (F27)
  ConversationController.ts  # Calls ContextManager per turn (referenced, not defined here)
```

---

## 3. `src/conversation/ContextManager.ts`

### 3.1 Design Principles

`ContextManager` is **immutable**: every state transition returns a new instance. The
`ConversationController` holds a reference and replaces it each turn:

```typescript
// In ConversationController:
this.context = this.context.append(userMessage);
// ... run loop ...
this.context = await this.context.maybeCompactAsync(this.client, this.model);
```

This means:
- No mutation bugs from concurrent modifications.
- Straightforward to test (create, call methods, assert on returned instances).
- `/clear` is trivially `this.context = this.context.reset()`.

### 3.2 Token Estimation

Exact token counting requires a tokenizer (which is heavy and language-specific). We use a
character-count heuristic: 1 token ≈ 4 characters. This is accurate to within ~20% for
English text and is fast (O(n) string scan).

`COMPACTION_THRESHOLD = 150_000` tokens corresponds to ~600,000 characters. This leaves a
comfortable margin below Claude's context window while still compacting before performance
degrades.

### 3.3 Full Implementation

```typescript
// src/conversation/ContextManager.ts

import type Anthropic from '@anthropic-ai/sdk';
import { summarizeMessages } from './Compactor.js';

/** 1 token ≈ 4 characters. Heuristic; accurate to ±20% for English. */
const CHARS_PER_TOKEN = 4;

/**
 * Token threshold at which compaction is triggered.
 * 150K tokens × 4 chars/token = 600K characters.
 * This leaves headroom for the system prompt and tool definitions.
 */
const COMPACTION_THRESHOLD_TOKENS = 150_000;

/** Number of recent messages to keep verbatim during compaction. */
const VERBATIM_TAIL_COUNT = 20;

/**
 * ContextManager holds the ordered conversation message array.
 * It is immutable: all methods return new instances.
 *
 * Callers store the returned instance and discard the old one:
 *   this.context = this.context.append(msg);
 */
export class ContextManager {
  /**
   * The internal messages array. ReadonlyArray enforces immutability at the type level.
   * The objects themselves (MessageParam) are not deeply frozen — callers must not
   * mutate them.
   */
  private readonly messages: ReadonlyArray<Anthropic.MessageParam>;

  constructor(messages: ReadonlyArray<Anthropic.MessageParam> = []) {
    this.messages = messages;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /**
   * The number of user-role turns in the conversation.
   * Counts only user messages (not assistant messages or tool results).
   * Used for `/info` display and session stats.
   */
  get turnCount(): number {
    return this.messages.filter((m) => m.role === 'user').length;
  }

  /**
   * A snapshot of the current messages array.
   * Returns a new array each time (defensive copy) so callers cannot mutate
   * the internal state via the returned reference.
   */
  get snapshot(): ReadonlyArray<Anthropic.MessageParam> {
    return [...this.messages];
  }

  /**
   * Estimated token count of all messages.
   * Uses the character-count heuristic: chars / CHARS_PER_TOKEN.
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

  // ── State transitions (return new ContextManager) ──────────────────────────

  /**
   * Append a new message to the conversation.
   * Returns a new ContextManager with the message added.
   *
   * Immutability: uses spread to create a new array. The original is unchanged.
   */
  append(message: Anthropic.MessageParam): ContextManager {
    return new ContextManager([...this.messages, message]);
  }

  /**
   * Reset the conversation to an empty state.
   * Used by the `/clear` slash command.
   * Returns a new ContextManager with zero messages.
   */
  reset(): ContextManager {
    return new ContextManager([]);
  }

  // ── Compaction (F12, F27) ──────────────────────────────────────────────────

  /**
   * Check if compaction is needed and, if so, compact the conversation.
   *
   * Phase 1: uses a synchronous placeholder (no API call).
   * Phase 3: upgrades to async API-based summarization.
   *
   * Returns:
   * - `this` if no compaction is needed (same instance, no allocation).
   * - A new ContextManager with compacted messages if compaction was triggered.
   *
   * @param client - The Anthropic SDK client (passed through from ConversationController).
   * @param model - The model to use for summarization.
   */
  async maybeCompactAsync(
    client: import('@anthropic-ai/sdk').default,
    model: string
  ): Promise<ContextManager> {
    if (this.estimatedTokenCount <= COMPACTION_THRESHOLD_TOKENS) {
      return this; // No compaction needed.
    }

    return this.compact(client, model);
  }

  /**
   * Perform compaction: summarize old messages and keep the recent tail verbatim.
   *
   * Strategy:
   * 1. Keep the last VERBATIM_TAIL_COUNT messages exactly as-is.
   * 2. Summarize all older messages into a single compact summary message.
   * 3. Return a new ContextManager with: [summaryMessage, ...tailMessages]
   *
   * The summary message is injected as a "user" role message with a special prefix
   * so the model understands it is a context summary, not a user instruction.
   */
  private async compact(
    client: import('@anthropic-ai/sdk').default,
    model: string
  ): Promise<ContextManager> {
    const total = this.messages.length;

    if (total <= VERBATIM_TAIL_COUNT) {
      // Not enough messages to summarize — cannot compact meaningfully.
      return this;
    }

    const oldMessages = this.messages.slice(0, total - VERBATIM_TAIL_COUNT);
    const tailMessages = this.messages.slice(total - VERBATIM_TAIL_COUNT);

    let summaryText: string;
    try {
      summaryText = await summarizeMessages(client, model, [...oldMessages]);
    } catch (error) {
      // If summarization fails, fall back to a placeholder.
      // This keeps the session alive rather than crashing.
      const fallback =
        `[Context summary unavailable due to an error: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `${oldMessages.length} messages were omitted.]`;
      summaryText = fallback;
    }

    const summaryMessage: Anthropic.MessageParam = {
      role: 'user',
      content:
        `[CONTEXT SUMMARY — This is an automatically generated summary of the earlier ` +
        `conversation to preserve context while staying within the token limit.]\n\n` +
        summaryText,
    };

    // Insert an assistant acknowledgment after the summary so the conversation
    // alternation (user → assistant → user) is maintained.
    const acknowledgment: Anthropic.MessageParam = {
      role: 'assistant',
      content: `[Context summary received. Continuing from the summary.]`,
    };

    return new ContextManager([summaryMessage, acknowledgment, ...tailMessages]);
  }
}
```

---

## 4. `src/conversation/Compactor.ts` (F27)

### 4.1 Purpose

`Compactor.ts` contains the single function `summarizeMessages()` that calls the Anthropic
API with a specialized summarization prompt. It is a thin utility module, not a class.

### 4.2 Design

The summarization call uses the **same API client** as the main conversation, but with a
different system prompt and a fresh messages array (not the conversation history). This
ensures the summarization does not leak into the conversation's token budget.

```typescript
// src/conversation/Compactor.ts

import type Anthropic from '@anthropic-ai/sdk';

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer.
Your task is to produce a dense, factual summary of a conversation between a user
and an AI coding assistant.

Rules:
- Include all files that were read, written, or modified (with their paths).
- Include all commands that were run and their outcomes.
- Include all decisions made and their rationale.
- Include any errors encountered and how they were resolved.
- Use bullet points grouped by topic.
- Do not include pleasantries, acknowledgments, or meta-commentary.
- Write in past tense ("The user asked...", "The assistant ran...").
- Be concise: aim for 300–500 words. Never exceed 1000 words.
`;

/**
 * Summarize a list of messages into a compact text summary.
 *
 * This function makes a real API call. It should only be called when compaction
 * is genuinely needed (token threshold exceeded). Errors propagate to the caller,
 * which falls back to a placeholder summary (see ContextManager.compact()).
 *
 * @param client - The Anthropic SDK client.
 * @param model - The model to use for summarization (typically the session model).
 * @param messages - The messages to summarize. Should be the oldest portion of the history.
 * @returns A compact summary string.
 */
export async function summarizeMessages(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  if (messages.length === 0) {
    return '(no messages to summarize)';
  }

  // Build a user prompt that presents the conversation as a transcript.
  const transcript = messages
    .map((msg) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map((block) => {
                if ('text' in block) return block.text;
                if (block.type === 'tool_use') return `[Tool call: ${block.name}]`;
                if (block.type === 'tool_result') {
                  return `[Tool result: ${typeof block.content === 'string' ? block.content.slice(0, 200) : '(structured)'}]`;
                }
                return '[Unknown block]';
              })
              .join('\n');
      return `${role}: ${content}`;
    })
    .join('\n\n---\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 1_024,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Please summarize the following conversation:\n\n${transcript}`,
      },
    ],
  });

  // Extract the text from the response.
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Summarization API returned no text content.');
  }

  return textBlock.text;
}
```

---

## 5. How `ConversationController` Uses `ContextManager`

Each turn follows this sequence (excerpt):

```typescript
// src/conversation/ConversationController.ts (excerpt)

async handleInput(userText: string): Promise<void> {
  // 1. Append the user message — returns new context, does not mutate.
  this.context = this.context.append({
    role: 'user',
    content: userText,
  });

  // 2. Run the agentic loop (may recurse for tool calls).
  await this.runAgenticLoop();

  // 3. After the loop, check if compaction is needed.
  //    maybeCompactAsync() returns `this` if no compaction is needed (no allocation).
  this.context = await this.context.maybeCompactAsync(this.client, this.activeModel);
}

private async runAgenticLoop(): Promise<void> {
  // Use context.snapshot to get the current messages for the API call.
  const messages = this.context.snapshot;

  // ... stream events from AnthropicClient ...

  // After getting the assistant response:
  this.context = this.context.append({
    role: 'assistant',
    content: assistantContent,
  });

  // After running tools:
  // Append all tool_result messages.
  this.context = this.context.append({
    role: 'user',
    content: toolResults, // Array of tool_result blocks.
  });

  // Recurse if there were tool calls.
  if (hadToolCalls) {
    await this.runAgenticLoop();
  }
}
```

**Key observation:** `this.context` is reassigned on every call to `append()`. This is the
correct pattern for immutable state management. The old instance is garbage-collected.

---

## 6. Messages Array Growth Per Turn

Example: a turn where the model reads a file and then replies.

```
Before turn:
  messages = [
    { role: 'user', content: 'Who wrote main()?' }        // Turn 1 user
    { role: 'assistant', content: 'Let me check...' }     // Turn 1 assistant (tool use)
    { role: 'user', content: [tool_result] }              // Turn 1 tool results
    { role: 'assistant', content: 'Bob wrote main().' }   // Turn 1 final reply
  ]

handleInput("What else did Bob write?") — appends:
  { role: 'user', content: 'What else did Bob write?' }

runAgenticLoop() — model calls read_file("src/utils.ts") — appends:
  { role: 'assistant', content: [tool_use block] }

Tool runs, result appended:
  { role: 'user', content: [tool_result block] }

Model gives final answer — appends:
  { role: 'assistant', content: 'Bob also wrote parseArgs()...' }

After turn:
  messages = [8 items]
```

Every user-initiated turn adds at minimum 2 messages (user input + assistant reply).
Tool use adds 2 more per tool call (assistant tool_use + user tool_result).

---

## 7. Why Keep the Last 20 Messages Verbatim

The last 20 messages are the most relevant for the current task:

1. **Recency bias:** the model's current intent is expressed in recent messages.
   If the model just ran a tool and got a result, that result must be verbatim — not
   summarized — or the model may hallucinate what the result said.

2. **Tool result integrity:** tool_result messages must match the tool_use messages that
   preceded them. The Anthropic API validates this pairing. If we summarize one but not
   the other, the conversation becomes malformed.

3. **Context coherence:** summarizing the last few messages is likely to lose the precise
   context the user was discussing. Keeping a full verbatim tail prevents this.

20 messages is approximately 2–4 user turns with tool use, which is enough to preserve
the immediately relevant context for any ongoing task.

---

## 8. Phased Delivery

### Phase 1 (F4, F12 — placeholder)

`maybeCompactAsync()` is implemented but delegates to a synchronous placeholder instead of
calling the API:

```typescript
// Phase 1 placeholder in Compactor.ts:
export async function summarizeMessages(
  _client: unknown,
  _model: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  return `[Placeholder summary: ${messages.length} messages from the earlier conversation were omitted due to context length. Please ask the user to use /clear if the context becomes too long.]`;
}
```

This placeholder ensures the compaction mechanism is integrated and tested end-to-end
(threshold detection, message slicing, summary insertion) before the real summarization
API call is added in Phase 3.

### Phase 3 (F27 — real summarization)

Replace the placeholder in `Compactor.ts` with the real implementation that calls
`client.messages.create()` with the summarization system prompt.

---

## 9. Test Cases

### 9.1 `ContextManager` — Core Operations

| Test | Scenario | Expected |
|------|----------|----------|
| Constructor default | `new ContextManager()` | `turnCount === 0`, `snapshot === []` |
| append | append 1 user message | new instance, `turnCount === 1`, original unchanged |
| append preserves old | append to instance A → B | A still has original messages |
| reset | reset after 5 messages | new instance with 0 messages |
| snapshot defensive copy | mutate returned snapshot | original messages unchanged |
| turnCount | 3 user + 2 assistant messages | `turnCount === 3` |

### 9.2 `ContextManager` — Token Estimation

| Test | Scenario | Expected |
|------|----------|----------|
| Empty | no messages | `estimatedTokenCount === 0` |
| String content | one message with 400 chars | `estimatedTokenCount === 100` |
| Array content | message with text blocks | chars across all blocks / 4 |
| Mixed | user + assistant + tool blocks | sum of all text content |

### 9.3 `ContextManager` — Compaction Trigger

| Test | Scenario | Expected |
|------|----------|----------|
| Under threshold | estimatedTokenCount < 150K | returns same instance (no-op) |
| Over threshold | estimatedTokenCount > 150K | returns new instance with summary |
| Summary injected | after compaction | first message is the summary |
| Tail preserved | 25 messages, VERBATIM=20 | last 20 messages verbatim in output |
| Too few to compact | 15 messages | returns same instance (< VERBATIM_TAIL_COUNT) |
| Summarization error | `summarizeMessages` throws | falls back to placeholder, no crash |

### 9.4 `Compactor.summarizeMessages()`

| Test | Scenario | Expected |
|------|----------|----------|
| Empty messages | `[]` | returns placeholder string without API call |
| Real call (mocked) | 5 messages | calls `client.messages.create()` once |
| No text block | API returns empty content | throws with descriptive message |
| Transcript format | messages with tool_use blocks | tool calls appear as `[Tool call: name]` |
| Long tool result | tool result > 200 chars | truncated to 200 chars in transcript |

### 9.5 ConversationController Integration

| Test | Scenario | Expected |
|------|----------|----------|
| append per turn | each handleInput call | context.turnCount increments |
| immutability | handleInput runs concurrently | no race conditions (sequential) |
| compaction on threshold | mock estimatedTokenCount > threshold | maybeCompactAsync called |
| /clear via reset | reset() | empty context, turnCount = 0 |
