/**
 * Shape a model tool call into an ApprovalRequest that routes through Mivlet's
 * existing approval queue before execution. Model-generated tool output is
 * untrusted content crossing into trusted action — the approval gate applies
 * before any tool runs.
 *
 * Unregistered tools (anything not in Mivlet's tool registry) fail closed:
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

/** Normalize a web-fetch URL for approval fingerprinting so the bound request
 *  uses a canonical form (no default ports, no embedded credentials). The Rust
 *  boundary applies the same normalization when re-computing the expected
 *  preview so approval binding cannot be bypassed by encoding differences.
 */
function normalizeWebFetchUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    // Strip default ports for canonical form.
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Match the native cloud-browser proposal canonicalization. Navigation is
 * HTTPS-only and fragments are removed because they are not sent to the
 * remote page. Keeping the approval preview canonical lets Rust bind the
 * source tool approval to the exact prepared navigation proposal. */
function normalizeCloudBrowserUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeLocalBrowserUrl(raw: string): string | null {
  const normalized = normalizeWebFetchUrl(raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.hash = "";
  return url.toString();
}

/** Build the ApprovalRequest for a model-emitted tool call. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalValue(nested)])
  );
  return value;
}

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
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, 16)
    .map(([key, value]) => {
      let vstr = typeof value === "string" ? value : JSON.stringify(canonicalValue(value));
      if (toolName === "web-fetch" && key === "url" && typeof value === "string") {
        const norm = normalizeWebFetchUrl(value);
        if (norm) vstr = norm;
      }
      if (toolName === "cloud-browser" && key === "url" && typeof value === "string") {
        const norm = normalizeCloudBrowserUrl(value);
        if (norm) vstr = norm;
      }
      if (toolName === "local-browser" && key === "url" && typeof value === "string") {
        const norm = normalizeLocalBrowserUrl(value);
        if (norm) vstr = norm;
      }
      return `${key}: ${vstr}`;
    });

  const actionCore = `${toolName} ${dataUsed.join(" ")}`.trim().slice(0, 80);
  const consequence = isRegistered
    ? `Execute the ${toolName} tool via ${providerId} with the given arguments.`
    : `Refuse unregistered tool ${toolName} — not in Mivlet's tool registry.`;

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
    // Tool execution permits are one-time. Saved/session grants are not offered
    // until the native boundary can mint a fresh exact permit from them.
    decisions: ["once", "modify", "deny"],
    // High/critical full-access risk requires exact confirmation (existing system).
    confirmationPhrase:
      mode === "full-access" && (risk === "high" || risk === "critical")
        ? `approve ${toolName}`
        : undefined
  };
}
