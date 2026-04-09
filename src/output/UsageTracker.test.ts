import { describe, it, expect } from 'vitest';
import { UsageTracker } from './UsageTracker.js';

describe('UsageTracker', () => {
  it('starts with zero totals', () => {
    const t = new UsageTracker();
    const { inputTokens, outputTokens } = t.totals();
    expect(inputTokens).toBe(0);
    expect(outputTokens).toBe(0);
  });

  it('accumulates tokens across multiple calls for the same model', () => {
    const t = new UsageTracker();
    t.record('claude-sonnet-4-6', 1000, 200);
    t.record('claude-sonnet-4-6', 500, 100);
    const { inputTokens, outputTokens } = t.totals();
    expect(inputTokens).toBe(1500);
    expect(outputTokens).toBe(300);
  });

  it('tracks usage separately per model and sums across models in totals()', () => {
    const t = new UsageTracker();
    t.record('claude-sonnet-4-6', 1000, 0);
    t.record('claude-opus-4-6', 2000, 0);
    const { inputTokens } = t.totals();
    expect(inputTokens).toBe(3000);
  });

  it('computes cost using the correct per-model pricing', () => {
    const t = new UsageTracker();
    // claude-sonnet-4-6: $3.00 / 1M input tokens
    t.record('claude-sonnet-4-6', 1_000_000, 0);
    expect(t.estimatedCostUsd()).toBeCloseTo(3.0, 5);
  });

  it('computes output token cost independently', () => {
    const t = new UsageTracker();
    // claude-sonnet-4-6: $15.00 / 1M output tokens
    t.record('claude-sonnet-4-6', 0, 1_000_000);
    expect(t.estimatedCostUsd()).toBeCloseTo(15.0, 5);
  });

  it('sums costs across multiple models at their respective rates', () => {
    const t = new UsageTracker();
    // Sonnet: 1M input = $3.00
    t.record('claude-sonnet-4-6', 1_000_000, 0);
    // Opus: 1M input = $15.00
    t.record('claude-opus-4-6', 1_000_000, 0);
    expect(t.estimatedCostUsd()).toBeCloseTo(18.0, 5);
  });

  it('uses unknown/fallback pricing for unrecognised models', () => {
    const t = new UsageTracker();
    // Fallback rate = Sonnet rate: $3.00 / 1M input
    t.record('claude-future-model-99', 1_000_000, 0);
    expect(t.estimatedCostUsd()).toBeCloseTo(3.0, 5);
  });

  it('formatSummary returns friendly message when no calls recorded', () => {
    const t = new UsageTracker();
    expect(t.formatSummary()).toBe('No API calls recorded this session.');
  });

  it('formatSummary includes all tracked model names', () => {
    const t = new UsageTracker();
    t.record('claude-sonnet-4-6', 1000, 200);
    t.record('claude-opus-4-6', 500, 100);
    const s = t.formatSummary();
    expect(s).toContain('claude-sonnet-4-6');
    expect(s).toContain('claude-opus-4-6');
  });

  it('formatSummary includes estimated cost line', () => {
    const t = new UsageTracker();
    t.record('claude-sonnet-4-6', 1000, 200);
    expect(t.formatSummary()).toContain('Estimated cost:');
  });

  it('summary() returns structured object with turnCount', () => {
    const t = new UsageTracker();
    t.recordTurn();
    t.recordTurn();
    t.record('claude-sonnet-4-6', 100, 50);
    const s = t.summary();
    expect(s.turnCount).toBe(2);
    expect(s.totalInputTokens).toBe(100);
    expect(s.totalOutputTokens).toBe(50);
    expect(s.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('summary() returns zero turn count when recordTurn() never called', () => {
    const t = new UsageTracker();
    expect(t.summary().turnCount).toBe(0);
  });
});
