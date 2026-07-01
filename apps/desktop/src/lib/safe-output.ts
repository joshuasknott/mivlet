/**
 * Safe connector-result inspection helpers.
 *
 * Run detail renders structured outputs (workflow step inputs/outputs, connector
 * read results, tool call arguments). Those values originate outside the app's
 * trust boundary and may transitively carry secrets a connector leaked into a
 * response — API keys, bearer tokens, credentials. This module is the single
 * funnel that turns an arbitrary `unknown` value into something safe to render:
 *
 *   1. Redact known secret shapes (never render raw credentials).
 *   2. Bound size so a multi-megabyte connector payload can't freeze the UI.
 *   3. Format as readable, stable JSON (or a plain string fallback).
 *
 * It is deliberately pure and dependency-free so it can be unit-tested in
 * isolation and reused by any future inspection surface.
 */

/** Maximum characters of formatted output before truncation kicks in. */
export const MAX_SAFE_OUTPUT_CHARS = 20_000;
/** Truncation marker appended when a value exceeds the bound. */
export const TRUNCATION_MARKER = "…[truncated]";

/**
 * Key names whose values are always redacted, regardless of content. Matches
 * common credential field names across connector payloads.
 */
const SENSITIVE_KEY = /^(api[-_]?key|token|password|passwd|secret|credential|authorization|cookie|session[-_]?token|access[-_]?token|refresh[-_]?token|secret[-_]?token|client[-_]?secret|private[-_]?key)$/i;

/** Substring patterns that look like inline credentials inside larger strings. */
const SENSITIVE_STRING_PATTERNS: RegExp[] = [
  /\bsk-ant-[a-zA-Z0-9_\-]{20,}\b/g, // Anthropic
  /\bsk-[a-zA-Z0-9_\-]{20,}\b/g, // OpenAI
  /\bAIzaSy[a-zA-Z0-9_\-]{33}\b/g, // Google/Gemini
  /\bBearer\s+[a-zA-Z0-9\-._~+/]{10,}(?:=*)?\b/gi // bearer tokens
];

/**
 * Recursively clone a value, replacing sensitive keys with `[REDACTED]` and
 * scrubbing credential-like substrings out of string values. Non-JSON-safe
 * values (functions, symbols, undefined) are dropped to keep the output stable.
 */
export function redactSecrets<T>(value: T): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSecrets(entry);
    }
    return out;
  }
  return value;
}

function redactString(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_STRING_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * Format an arbitrary value as readable text for inspection.
 *
 * - Objects/arrays: pretty-printed, 2-space JSON.
 * - Strings that are themselves JSON: parsed then pretty-printed (so connector
 *   responses that arrived as a JSON string still render structured).
 * - Primitives: their `String()` form.
 *
 * The result is always redacted and bounded to {@link MAX_SAFE_OUTPUT_CHARS}.
 */
export function formatForInspection(value: unknown): string {
  const redacted = redactSecrets(value);
  const formatted = stringify(redacted);
  if (formatted.length <= MAX_SAFE_OUTPUT_CHARS) return formatted;
  return `${formatted.slice(0, MAX_SAFE_OUTPUT_CHARS)}\n${TRUNCATION_MARKER}`;
}

/**
 * Best-effort parse of a value that may be a JSON string. Used to detect
 * connector outputs that arrived as a serialized string.
 */
export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    // A string value might itself be JSON a connector serialized; render it
    // structured when it is, otherwise leave it as plain text.
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      const parsed = tryParseJson(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(redactSecrets(parsed), null, 2);
      }
    }
    return value;
  }
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
