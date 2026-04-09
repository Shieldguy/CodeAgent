import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ContextManager } from './ContextManager.js';
import * as Compactor from './Compactor.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function userMsg(content: string): Anthropic.MessageParam {
  return { role: 'user', content };
}

function assistantMsg(content: string): Anthropic.MessageParam {
  return { role: 'assistant', content };
}

/** Create a message with enough characters to push over the compaction threshold.
 *  150 000 tokens × 4 chars/token = 600 000 chars.  */
function bigUserMsg(chars: number): Anthropic.MessageParam {
  return { role: 'user', content: 'x'.repeat(chars) };
}

const MOCK_CLIENT = {} as Anthropic;
const MOCK_MODEL = 'claude-sonnet-4-6';

// ── ContextManager — core operations ─────────────────────────────────────────

describe('ContextManager — core', () => {
  it('starts empty by default', () => {
    const ctx = new ContextManager();
    expect(ctx.turnCount).toBe(0);
    expect(ctx.snapshot).toHaveLength(0);
  });

  it('append returns a new instance with the message added', () => {
    const a = new ContextManager();
    const b = a.append(userMsg('hello'));

    expect(b.turnCount).toBe(1);
    expect(b.snapshot).toHaveLength(1);
  });

  it('append does not mutate the original instance', () => {
    const a = new ContextManager();
    a.append(userMsg('hello'));

    expect(a.turnCount).toBe(0);
    expect(a.snapshot).toHaveLength(0);
  });

  it('chained appends accumulate correctly', () => {
    const ctx = new ContextManager()
      .append(userMsg('msg1'))
      .append(assistantMsg('reply1'))
      .append(userMsg('msg2'));

    expect(ctx.snapshot).toHaveLength(3);
    expect(ctx.turnCount).toBe(2); // Only user messages count.
  });

  it('reset returns empty context', () => {
    const ctx = new ContextManager()
      .append(userMsg('a'))
      .append(assistantMsg('b'))
      .reset();

    expect(ctx.turnCount).toBe(0);
    expect(ctx.snapshot).toHaveLength(0);
  });

  it('reset does not affect the original instance', () => {
    const original = new ContextManager()
      .append(userMsg('a'))
      .append(userMsg('b'));
    original.reset();

    expect(original.turnCount).toBe(2);
  });

  it('snapshot returns a defensive copy', () => {
    const ctx = new ContextManager().append(userMsg('original'));
    const snap = ctx.snapshot as Anthropic.MessageParam[];
    snap.push(userMsg('mutated'));

    expect(ctx.snapshot).toHaveLength(1); // Internal array unchanged.
  });

  it('turnCount counts only user-role messages', () => {
    const ctx = new ContextManager()
      .append(userMsg('u1'))
      .append(assistantMsg('a1'))
      .append(userMsg('u2'))
      .append(assistantMsg('a2'))
      .append(userMsg('u3'));

    expect(ctx.turnCount).toBe(3);
  });
});

// ── ContextManager — token estimation ────────────────────────────────────────

describe('ContextManager — estimatedTokenCount', () => {
  it('returns 0 for empty context', () => {
    expect(new ContextManager().estimatedTokenCount).toBe(0);
  });

  it('estimates tokens for string content (1 token per 4 chars)', () => {
    const ctx = new ContextManager().append(userMsg('x'.repeat(400)));
    expect(ctx.estimatedTokenCount).toBe(100);
  });

  it('estimates tokens across multiple messages', () => {
    const ctx = new ContextManager()
      .append(userMsg('x'.repeat(400)))
      .append(assistantMsg('y'.repeat(400)));
    expect(ctx.estimatedTokenCount).toBe(200);
  });

  it('estimates tokens from array content blocks', () => {
    const msg: Anthropic.MessageParam = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(400) },
        { type: 'text', text: 'y'.repeat(400) },
      ],
    };
    const ctx = new ContextManager().append(msg);
    expect(ctx.estimatedTokenCount).toBe(200);
  });

  it('ignores non-text blocks in arrays', () => {
    const msg: Anthropic.MessageParam = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'x' } },
      ],
    };
    const ctx = new ContextManager().append(msg);
    // tool_use blocks have no text — should contribute 0.
    expect(ctx.estimatedTokenCount).toBe(0);
  });

  it('rounds up fractional tokens', () => {
    // 5 chars / 4 = 1.25 → ceil → 2
    const ctx = new ContextManager().append(userMsg('hello'));
    expect(ctx.estimatedTokenCount).toBe(2);
  });
});

// ── ContextManager — compaction ───────────────────────────────────────────────

describe('ContextManager — compaction', () => {
  beforeEach(() => {
    vi.spyOn(Compactor, 'summarizeMessages').mockResolvedValue('mock summary');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns same instance when under threshold', async () => {
    const ctx = new ContextManager().append(userMsg('short message'));
    const result = await ctx.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);

    expect(result).toBe(ctx); // Same reference — no allocation.
  });

  it('returns new instance when over threshold', async () => {
    // Need >20 messages total AND exceed the 150 000 token threshold.
    // 21 messages × 30 000 chars each = 630 000 chars / 4 = 157 500 tokens > 150 000.
    let ctx = new ContextManager();
    for (let i = 0; i < 21; i++) ctx = ctx.append(bigUserMsg(30_000));

    const result = await ctx.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);

    expect(result).not.toBe(ctx);
  });

  it('inserts summary message as first message after compaction', async () => {
    let ctx = new ContextManager();
    for (let i = 0; i < 21; i++) ctx = ctx.append(bigUserMsg(30_000));

    const result = await ctx.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);

    const snap = result.snapshot;
    expect(typeof snap[0]?.content).toBe('string');
    expect((snap[0]?.content as string)).toContain('CONTEXT SUMMARY');
  });

  it('keeps the verbatim tail (last 20 messages) intact', async () => {
    // Build 25 messages so there is an oldMessages portion to summarize.
    let ctx = new ContextManager();
    for (let i = 0; i < 5; i++) {
      ctx = ctx.append(bigUserMsg(60_100)); // Each ~15 025 tokens; 5 × = ~75 025 (still under)
    }
    // Push it over the threshold.
    ctx = ctx.append(bigUserMsg(300_500));

    // Add 20 verbatim tail messages.
    for (let i = 0; i < 20; i++) {
      ctx = ctx.append(userMsg(`tail-${i}`));
    }

    const result = await ctx.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);
    const snap = result.snapshot;

    // snap[0] = summary, snap[1] = acknowledgment, snap[2..] = tail
    const tailMessages = snap.slice(2);
    expect(tailMessages).toHaveLength(20);
    expect(tailMessages[0]?.content).toBe('tail-0');
    expect(tailMessages[19]?.content).toBe('tail-19');
  });

  it('returns same instance when message count <= VERBATIM_TAIL_COUNT', async () => {
    // Force over threshold via token count but only 15 messages.
    let ctx = new ContextManager();
    for (let i = 0; i < 15; i++) {
      ctx = ctx.append(bigUserMsg(40_100)); // Each ~10 025 tokens; 15 × = ~150 375 tokens
    }

    const result = await ctx.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);

    // Cannot compact fewer messages than VERBATIM_TAIL_COUNT (20) — returns self.
    expect(result).toBe(ctx);
  });

  it('falls back to placeholder when summarizeMessages throws', async () => {
    vi.spyOn(Compactor, 'summarizeMessages').mockRejectedValue(new Error('API timeout'));

    let ctx = new ContextManager();
    for (let i = 0; i < 21; i++) ctx = ctx.append(bigUserMsg(30_000));

    const result = await ctx.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);
    const firstContent = result.snapshot[0]?.content as string;

    expect(firstContent).toContain('CONTEXT SUMMARY');
    expect(firstContent).toContain('API timeout');
  });

  it('calls summarizeMessages with the old-message portion', async () => {
    const spy = vi
      .spyOn(Compactor, 'summarizeMessages')
      .mockResolvedValue('summary text');

    // 25 messages — 5 old + 20 tail
    let ctx = new ContextManager();
    for (let i = 0; i < 5; i++) ctx = ctx.append(bigUserMsg(60_100));
    for (let i = 0; i < 20; i++) ctx = ctx.append(userMsg(`tail-${i}`));
    // Extra push to exceed the threshold (the 5 big messages cover ~75 125 tokens,
    // need to exceed 150 000 — add another big one at the front via rebuild).
    let ctx2 = new ContextManager();
    for (let i = 0; i < 10; i++) ctx2 = ctx2.append(bigUserMsg(60_100)); // ~150 250 tokens
    for (let i = 0; i < 20; i++) ctx2 = ctx2.append(userMsg(`tail-${i}`));

    await ctx2.maybeCompactAsync(MOCK_CLIENT, MOCK_MODEL);

    expect(spy).toHaveBeenCalledOnce();
    // First argument is the old messages (total - 20).
    const [, , passedMessages] = spy.mock.calls[0] as [unknown, unknown, Anthropic.MessageParam[]];
    expect(passedMessages.length).toBe(10); // 30 total - 20 tail = 10 old
  });
});

// ── Compactor.summarizeMessages — Phase 1 placeholder ─────────────────────────

describe('Compactor.summarizeMessages (Phase 1 placeholder)', () => {
  it('returns placeholder string for non-empty messages without API call', async () => {
    vi.restoreAllMocks(); // Ensure no spy is active.
    const { summarizeMessages } = await import('./Compactor.js');

    const msgs: Anthropic.MessageParam[] = [userMsg('a'), assistantMsg('b')];
    const result = await summarizeMessages(MOCK_CLIENT, MOCK_MODEL, msgs);

    expect(result).toContain('2 messages');
  });

  it('returns no-op string for empty messages', async () => {
    const { summarizeMessages } = await import('./Compactor.js');
    const result = await summarizeMessages(MOCK_CLIENT, MOCK_MODEL, []);
    expect(result).toBe('(no messages to summarize)');
  });
});
