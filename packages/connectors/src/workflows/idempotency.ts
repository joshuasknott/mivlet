export function workflowMutationKey(
  runId: string,
  stepId: string,
  tool: string,
  args: Record<string, unknown>
): string {
  const stable = JSON.stringify(
    Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)))
  );
  let hash = 2166136261;
  for (const character of `${runId}:${stepId}:${tool}:${stable}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `wf:${runId}:${stepId}:${(hash >>> 0).toString(16)}`;
}

export function assertFreshApproval(
  decision: { decision: "approved" | "denied" | "expired"; decidedAt?: string; expiresAt?: string } | undefined,
  now: Date
): "approved" | "denied" | "expired" | "pending" {
  if (!decision) return "pending";
  if (decision.decision !== "approved") return decision.decision;
  if (!decision.decidedAt || !decision.expiresAt) return "expired";
  const decided = Date.parse(decision.decidedAt);
  const expires = Date.parse(decision.expiresAt);
  if (!Number.isFinite(decided) || !Number.isFinite(expires) || decided > now.getTime() || expires <= now.getTime()) {
    return "expired";
  }
  return "approved";
}
