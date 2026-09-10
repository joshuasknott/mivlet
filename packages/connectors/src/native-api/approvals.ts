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

const ARGUMENT_DIGEST_PREFIX = "Arguments SHA-256: ";
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Synchronous browser-safe SHA-256 for binding an approval to a complete
 * canonical payload. Approval construction is synchronous across providers,
 * so Web Crypto's asynchronous digest cannot be used at this boundary. */
function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0; state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0; state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0; state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0; state[7] = (state[7]! + h!) >>> 0;
  }
  return Array.from(state, word => word.toString(16).padStart(8, "0")).join("");
}

function boundedPreview(value: string): string {
  // Match Rust char::is_whitespace/split_whitespace rather than JavaScript's
  // broader \s class (which also treats the non-whitespace BOM as whitespace).
  const normalized = value
    .replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, " ")
    .replace(/^ | $/gu, "");
  return Array.from(normalized).slice(0, 240).join("");
}

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
  const canonicalArguments = JSON.stringify(canonicalValue(parsed));
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
      const preview = `${key}: ${vstr}`;
      return toolName === "create-spreadsheet" || toolName === "create-document"
        ? boundedPreview(preview)
        : preview;
    });
  if (toolName === "create-spreadsheet" || toolName === "create-document") {
    dataUsed.push(`${ARGUMENT_DIGEST_PREFIX}${sha256Hex(canonicalArguments)}`);
  }

  const actionCore = `${toolName} ${dataUsed.join(" ")}`.trim().slice(0, 80);
  const consequence = toolName === "local-app-select" && isRegistered
    ? parsed.deliveryMode === "foreground"
      ? "Bring the selected Windows app forward and allow approved actions to use its foreground window. This may interrupt your work."
      : "Select the Windows app for supported background controls without bringing it forward. Each action still follows your approval settings."
    : isRegistered
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
