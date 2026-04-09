import { getPricing } from './pricing.js';

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Accumulates token usage per model across all turns in a session.
 *
 * Tracks per-model independently so mid-session agent/model switches
 * are costed at the correct rate for each model used.
 */
export class UsageTracker {
  private readonly perModel: Map<string, ModelUsage> = new Map();
  private turns = 0;

  /** Increment the turn counter. Called once per completed handleInput(). */
  recordTurn(): void {
    this.turns++;
  }

  /** Accumulate tokens for a single API response. */
  record(model: string, inputTokens: number, outputTokens: number): void {
    const prior = this.perModel.get(model) ?? { inputTokens: 0, outputTokens: 0 };
    this.perModel.set(model, {
      inputTokens: prior.inputTokens + inputTokens,
      outputTokens: prior.outputTokens + outputTokens,
    });
  }

  /** Total token counts across all models. */
  totals(): { inputTokens: number; outputTokens: number } {
    let input = 0;
    let output = 0;
    for (const u of this.perModel.values()) {
      input += u.inputTokens;
      output += u.outputTokens;
    }
    return { inputTokens: input, outputTokens: output };
  }

  /** Estimated total cost in USD across all models at their respective rates. */
  estimatedCostUsd(): number {
    let total = 0;
    for (const [model, u] of this.perModel.entries()) {
      const p = getPricing(model);
      total += (u.inputTokens / 1_000_000) * p.inputPer1M;
      total += (u.outputTokens / 1_000_000) * p.outputPer1M;
    }
    return total;
  }

  /**
   * Structured summary — used by the CLI exit handler and /usage command.
   * The `turnCount` field is what printUsageSummary() reads.
   */
  summary(): UsageSummary {
    const { inputTokens, outputTokens } = this.totals();
    return {
      turnCount: this.turns,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      estimatedCostUsd: this.estimatedCostUsd(),
    };
  }

  /**
   * Formatted multi-line string for display (used by /usage slash command).
   * Broken out from summary() so the structured data and display string stay separate.
   */
  formatSummary(): string {
    if (this.perModel.size === 0) {
      return 'No API calls recorded this session.';
    }

    const lines: string[] = ['Token usage this session:'];

    for (const [model, u] of this.perModel.entries()) {
      const p = getPricing(model);
      const inputCost = (u.inputTokens / 1_000_000) * p.inputPer1M;
      const outputCost = (u.outputTokens / 1_000_000) * p.outputPer1M;
      lines.push(`  ${model}:`);
      lines.push(`    Input:  ${u.inputTokens.toLocaleString()} tokens  ($${inputCost.toFixed(4)})`);
      lines.push(`    Output: ${u.outputTokens.toLocaleString()} tokens  ($${outputCost.toFixed(4)})`);
      lines.push(`    Model subtotal: $${(inputCost + outputCost).toFixed(4)}`);
    }

    const { inputTokens, outputTokens } = this.totals();
    const totalCost = this.estimatedCostUsd();

    lines.push('');
    lines.push(`  Total input:  ${inputTokens.toLocaleString()} tokens`);
    lines.push(`  Total output: ${outputTokens.toLocaleString()} tokens`);
    lines.push(`  Estimated cost: $${totalCost.toFixed(4)} USD`);
    lines.push('');
    lines.push('  Note: Costs are estimates. Actual billing may differ.');

    return lines.join('\n');
  }
}
