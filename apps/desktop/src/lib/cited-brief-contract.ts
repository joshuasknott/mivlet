export interface CitedBriefMissionPlanSummary {
  title: string;
  summary: string;
  executionLabel: string;
  step: {
    title: string;
    objective: string;
    capability: string;
    output: string;
  };
  acceptance: string[];
  requiresHumanAcceptance?: boolean;
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxToolCalls: number;
    maxDurationMs: number;
    maxAttempts: number;
  };
}

export interface CitedBriefMissionReceipt {
  acceptanceStatus: "accepted" | "not-accepted";
  acceptanceSummary: string;
  provider: string;
  model: string;
  routeReason: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  attemptNumber: number;
  sourceCount: number;
  trust: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxAttempts: number;
  costAmount?: string;
  costCurrency?: string;
  pricingReference?: string;
}

export function isCitedBriefMissionReceipt(
  value: unknown,
): value is CitedBriefMissionReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Record<string, unknown>;
  const required = [
    "acceptanceStatus",
    "acceptanceSummary",
    "provider",
    "model",
    "routeReason",
    "inputTokens",
    "outputTokens",
    "toolCalls",
    "durationMs",
    "attemptNumber",
    "sourceCount",
    "trust",
    "maxInputTokens",
    "maxOutputTokens",
    "maxToolCalls",
    "maxDurationMs",
    "maxAttempts",
  ];
  const optional = ["costAmount", "costCurrency", "pricingReference"];
  const exactKeys =
    Object.keys(receipt).every(
      (key) => required.includes(key) || optional.includes(key),
    ) && required.every((key) => key in receipt);
  const strings = [
    "acceptanceSummary",
    "provider",
    "model",
    "routeReason",
    "trust",
  ].every(
    (key) =>
      typeof receipt[key] === "string" &&
      (receipt[key] as string).trim().length > 0,
  );
  const counts = [
    "inputTokens",
    "outputTokens",
    "toolCalls",
    "durationMs",
    "sourceCount",
  ].every(
    (key) => Number.isInteger(receipt[key]) && (receipt[key] as number) >= 0,
  );
  const limits = [
    "maxInputTokens",
    "maxOutputTokens",
    "maxToolCalls",
    "maxDurationMs",
    "maxAttempts",
  ].every(
    (key) => Number.isInteger(receipt[key]) && (receipt[key] as number) > 0,
  );
  const presentCost = optional.filter((key) => key in receipt);
  const cost =
    presentCost.length === 0 ||
    (presentCost.length === optional.length &&
      optional.every(
        (key) =>
          typeof receipt[key] === "string" &&
          (receipt[key] as string).trim().length > 0,
      ));
  const utilization =
    Number.isInteger(receipt.attemptNumber) &&
    (receipt.attemptNumber as number) > 0 &&
    (receipt.attemptNumber as number) <= (receipt.maxAttempts as number) &&
    (receipt.durationMs as number) <= (receipt.maxDurationMs as number);
  return (
    exactKeys &&
    strings &&
    counts &&
    limits &&
    utilization &&
    cost &&
    (receipt.acceptanceStatus === "accepted" ||
      receipt.acceptanceStatus === "not-accepted")
  );
}

export function isCitedBriefMissionPlanSummary(
  value: unknown,
): value is CitedBriefMissionPlanSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const plan = value as Record<string, unknown>;
  const required = [
    "title",
    "summary",
    "executionLabel",
    "step",
    "acceptance",
    "budget",
  ];
  const exact = [...required, "requiresHumanAcceptance"];
  if (
    !required.every((key) => key in plan) ||
    !Object.keys(plan).every((key) => exact.includes(key)) ||
    ("requiresHumanAcceptance" in plan &&
      typeof plan.requiresHumanAcceptance !== "boolean")
  )
    return false;
  if (
    !["title", "summary", "executionLabel"].every(
      (key) => typeof plan[key] === "string" && (plan[key] as string).trim(),
    )
  )
    return false;
  const step = plan.step as Record<string, unknown> | undefined;
  if (
    !step ||
    Array.isArray(step) ||
    Object.keys(step).length !== 4 ||
    !["title", "objective", "capability", "output"].every(
      (key) => typeof step[key] === "string" && (step[key] as string).trim(),
    )
  )
    return false;
  if (
    !Array.isArray(plan.acceptance) ||
    plan.acceptance.length === 0 ||
    plan.acceptance.length > 8 ||
    plan.acceptance.some((item) => typeof item !== "string" || !item.trim())
  )
    return false;
  const budget = plan.budget as Record<string, unknown> | undefined;
  const limits = [
    "maxInputTokens",
    "maxOutputTokens",
    "maxToolCalls",
    "maxDurationMs",
    "maxAttempts",
  ];
  return (
    Boolean(budget) &&
    !Array.isArray(budget) &&
    Object.keys(budget!).length === limits.length &&
    Object.keys(budget!).every((key) => limits.includes(key)) &&
    limits.every(
      (key) => Number.isInteger(budget![key]) && (budget![key] as number) > 0,
    )
  );
}

export function isCitedBriefMissionPrompt(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(search|research|find)\b/.test(normalized) &&
    /\bconnected (work )?sources?\b/.test(normalized) &&
    /\b(cited|trustworthy)\b/.test(normalized) &&
    /\bbrief\b/.test(normalized)
  );
}
