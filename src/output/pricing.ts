export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** Pricing in USD per 1M tokens. Update when Anthropic changes rates. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4.0 },
  // Fallback for unknown models — defaults to Sonnet pricing.
  unknown: { inputPer1M: 3.0, outputPer1M: 15.0 },
};

export function getPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? MODEL_PRICING['unknown']!;
}
