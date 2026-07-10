/**
 * Per-provider list pricing (USD per 1M tokens) for usage/cost accounting.
 *
 * These are conservative public list rates used only for the user's own cost
 * display — Fable does not bill through these rates. Unknown providers fail-safe
 * to 0 (never a negative or invented cost).
 */

interface Rate {
  inputPerMillion: number;
  outputPerMillion: number;
}

const RATES: Record<string, Rate> = {
  openai: { inputPerMillion: 1.25, outputPerMillion: 10 },
  anthropic: { inputPerMillion: 3, outputPerMillion: 15 },
  gemini: { inputPerMillion: 1.25, outputPerMillion: 5 },
  xai: { inputPerMillion: 5, outputPerMillion: 15 },
  openrouter: { inputPerMillion: 1.25, outputPerMillion: 10 }
};

/** Whether Fable has a reviewed public rate for this provider. */
export function hasKnownPrice(providerId: string): boolean {
  return providerId in RATES;
}

/** Compute the USD cost for a token count. Fail-safe to 0 for unknown providers. */
export function priceFor(
  providerId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rate = RATES[providerId];
  if (!rate) return 0;
  const cost =
    (inputTokens / 1_000_000) * rate.inputPerMillion +
    (outputTokens / 1_000_000) * rate.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
