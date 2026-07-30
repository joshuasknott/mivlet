export interface ParallelApproachesPlanSummary {
  title: string;
  summary: string;
  executionLabel: string;
  steps: Array<{ title: string; objective: string; output: string }>;
  acceptance: string[];
  budget: {
    maxWorkers: number;
    maxDurationMs: number;
    maxOutputTokens: number;
    maxAttempts: number;
  };
}

export function isParallelApproachesMissionPrompt(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(generate|create|develop|propose|give me)\b/.test(normalized) &&
    /\btwo (independent |different |alternative )?approaches\b/.test(
      normalized,
    ) &&
    /\b(compare|comparison|trade-?offs?)\b/.test(normalized)
  );
}

/** Review is opt-in: ordinary comparison language must never create a judge. */
export function isReviewedParallelApproachesMissionPrompt(
  value: string,
): boolean {
  if (!isParallelApproachesMissionPrompt(value)) return false;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(independent|separate|third) (reviewer|judge)\b/.test(normalized) ||
    /\b(?:have|ask|use|add) (?:an? )?(?:independent |separate |third )?(reviewer|judge)\b/.test(
      normalized,
    ) ||
    /\b(reviewer|judge) (?:to )?(assess|evaluate|review|recommend)\b/.test(
      normalized,
    )
  );
}

export function isParallelApproachesPlanSummary(
  value: unknown,
): value is ParallelApproachesPlanSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (
    !Object.keys(plan).every((key) =>
      [
        "title",
        "summary",
        "executionLabel",
        "steps",
        "acceptance",
        "budget",
      ].includes(key),
    ) ||
    !["title", "summary", "executionLabel"].every(
      (key) =>
        typeof plan[key] === "string" && Boolean((plan[key] as string).trim()),
    ) ||
    !Array.isArray(plan.steps) ||
    ![3, 4].includes(plan.steps.length) ||
    plan.steps.some(
      (step) =>
        !step ||
        typeof step !== "object" ||
        Array.isArray(step) ||
        !["title", "objective", "output"].every(
          (key) =>
            typeof (step as Record<string, unknown>)[key] === "string" &&
            Boolean(((step as Record<string, unknown>)[key] as string).trim()),
        ),
    ) ||
    !Array.isArray(plan.acceptance) ||
    plan.acceptance.length !== 1 ||
    plan.acceptance.some(
      (criterion) => typeof criterion !== "string" || !criterion.trim(),
    )
  )
    return false;
  const budget = plan.budget as Record<string, unknown> | undefined;
  return (
    Boolean(budget) &&
    !Array.isArray(budget) &&
    ["maxWorkers", "maxDurationMs", "maxOutputTokens", "maxAttempts"].every(
      (key) => Number.isInteger(budget![key]) && (budget![key] as number) > 0,
    ) &&
    budget!.maxWorkers === (plan.steps.length === 4 ? 3 : 2)
  );
}
