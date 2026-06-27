/**
 * Shape a model tool call into an ApprovalRequest that routes through Fable's
 * existing approval queue before execution. Model-generated tool output is
 * untrusted content crossing into trusted action — the approval gate applies
 * before any tool runs.
 *
 * Unregistered tools (anything not in Fable's tool registry) fail closed:
 * critical risk, consequence names the refusal, and the loop never executes
 * them.
 */

import type { ApprovalRequest } from "@fable/protocol";
import { lookupTool } from "./tools";

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw: args };
  } catch {
    return { raw: args };
  }
}

/** Build the ApprovalRequest for a model-emitted tool call. */
export function buildToolApproval(
  providerId: string,
  toolName: string,
  args: string
): ApprovalRequest {
  const parsed = safeParseArgs(args);
  const registered = lookupTool(toolName);
  const isRegistered = Boolean(registered);

  // Unregistered tools fail closed: critical risk, never auto-executed.
  const mode = registered?.defaultMode ?? "full-access";
  const risk = registered?.defaultRisk ?? "critical";
  const dataUsed = Object.entries(parsed)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

  const actionCore = `${toolName} ${dataUsed.join(" ")}`.trim().slice(0, 80);
  const consequence = isRegistered
    ? `Execute the ${toolName} tool via ${providerId} with the given arguments.`
    : `Refuse unregistered tool ${toolName} — not in Fable's tool registry.`;

  const slug = `${providerId}-${actionCore}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return {
    id: `native-${slug}`.slice(0, 120),
    service: providerId,
    action: actionCore || toolName,
    mode,
    riskLevel: risk,
    dataUsed,
    consequence,
    requestedAt: new Date(0).toISOString(),
    decisions: ["once", "session", "rule", "modify", "deny"],
    // High/critical full-access risk requires exact confirmation (existing system).
    confirmationPhrase:
      mode === "full-access" && (risk === "high" || risk === "critical")
        ? `approve ${toolName}`
        : undefined
  };
}
