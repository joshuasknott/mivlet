/**
 * Cost accounting fails closed until Mivlet has an exact model-specific,
 * source-attributed price observation. Provider-wide rates are unsafe because
 * hosted providers expose models with materially different prices.
 */

/** Provider identity alone never proves a model price. */
export function hasKnownPrice(_providerId: string): boolean {
  return false;
}

/** Unknown cost is represented by zero plus `costUnknown: true` at the event boundary. */
export function priceFor(
  _providerId: string,
  _inputTokens: number,
  _outputTokens: number
): number {
  return 0;
}
