/**
 * The computer selected for a saved agent.
 *
 * This is deliberately a preference only. A run captures the value at
 * admission and the native boundary must resolve the selected machine and
 * connection revision again before granting any computer capability.
 * Credentials, leases, machine status and capability tokens never belong in
 * this type or in a runtime snapshot.
 */
export type AgentComputerPreference =
  | { kind: "local" }
  | {
      kind: "instabox";
      machineId: string;
      connectionRevision: number;
    };

export const DEFAULT_AGENT_COMPUTER: AgentComputerPreference = { kind: "local" };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

export function isAgentComputerPreference(
  value: unknown,
): value is AgentComputerPreference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "local") return true;
  return (
    candidate.kind === "instabox" &&
    typeof candidate.machineId === "string" &&
    SAFE_ID.test(candidate.machineId) &&
    typeof candidate.connectionRevision === "number" &&
    Number.isSafeInteger(candidate.connectionRevision) &&
    candidate.connectionRevision > 0
  );
}

/** Validate the non-secret preference before it enters a snapshot or request. */
export function normalizeAgentComputerPreference(
  value: unknown,
): AgentComputerPreference {
  if (!value || typeof value !== "object") return DEFAULT_AGENT_COMPUTER;
  if (isAgentComputerPreference(value)) {
    if (value.kind === "local") return DEFAULT_AGENT_COMPUTER;
    return {
      kind: "instabox",
      machineId: value.machineId,
      connectionRevision: value.connectionRevision,
    };
  }
  return DEFAULT_AGENT_COMPUTER;
}

/** A run-owned copy; preference changes cannot mutate an admitted task. */
export function cloneAgentComputerPreference(
  preference: AgentComputerPreference | undefined,
): AgentComputerPreference {
  const normalized = normalizeAgentComputerPreference(preference);
  return normalized.kind === "local"
    ? DEFAULT_AGENT_COMPUTER
    : { ...normalized };
}
