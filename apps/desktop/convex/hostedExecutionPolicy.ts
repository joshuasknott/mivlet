import type { HostedComputerSnapshot } from "@mivlet/protocol";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

export function requireHostedIdentifier(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

/** Stable, non-secret execution identity. FNV-1a is naming, never authorization. */
export function hostedComputerId(workspaceId: string, agentId: string): string {
  requireHostedIdentifier(workspaceId, "Workspace id");
  requireHostedIdentifier(agentId, "Agent id");
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${workspaceId}\u0000${agentId}`)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fc-${hash.toString(16).padStart(16, "0")}`;
}

export function hostedRunnerBaseUrl(value: string | undefined): URL {
  if (!value) throw new Error("runner-configuration-required");
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !url.hostname.includes(".")
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("runner-configuration-invalid");
  }
  return url;
}

export function validateHostedComputerSnapshot(value: unknown, computerId: string): HostedComputerSnapshot {
  if (!isRecord(value)
    || value.computerId !== computerId
    || !["unprovisioned", "provisioning", "ready", "degraded", "destroying", "destroyed"].includes(String(value.lifecycle))
    || typeof value.runtimeActive !== "boolean"
    || typeof value.keepAlive !== "boolean"
    || !Number.isInteger(value.generation)
    || Number(value.generation) < 0
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("The hosted runner returned an invalid computer snapshot.");
  }
  return {
    computerId: value.computerId,
    lifecycle: value.lifecycle as HostedComputerSnapshot["lifecycle"],
    runtimeActive: value.runtimeActive,
    keepAlive: value.keepAlive,
    generation: Number(value.generation),
    updatedAt: value.updatedAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
