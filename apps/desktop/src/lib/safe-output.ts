/**
 * Safe output boundary for untrusted content.
 *
 * Model, tool, connector, and streamed conversation output originates outside
 * the app's trust boundary and may transitively carry secrets, markup, or link
 * targets that must not gain authority. This module is the single funnel that
 * turns that output into something safe to render or open:
 *
 *   1. Redact known secret shapes (never render raw credentials).
 *   2. Bound size so a multi-megabyte payload can't freeze the renderer.
 *   3. Decode isolated HTML character references without ever parsing source
 *      HTML, so encoded prose is readable but markup stays literal text.
 *   4. Validate external link targets with the URL parser, mirroring the
 *      native opener: only http(s)/mailto, no credentials, no control
 *      characters. The decoded target — not a string prefix — decides.
 *
 * It is deliberately pure and dependency-free (aside from the platform
 * `URL` and `DOMParser` globals) so it can be unit-tested in isolation and
 * reused by any future rendering or inspection surface.
 */

/** Maximum characters of formatted output before truncation kicks in. */
export const MAX_SAFE_OUTPUT_CHARS = 20_000;
/** Maximum characters of a single conversation message rendered as Markdown. */
export const MAX_CONVERSATION_MARKDOWN_CHARS = 200_000;
/** Maximum length of an external link target accepted by the opener. */
export const MAX_SAFE_LINK_CHARS = 8_192;
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

/** Isolated HTML character references; never a tag or comment. */
const HTML_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,8}|#x[\da-fA-F]{1,8});/g;

/** C0/C1 control characters, matching the native link validator's rejection. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

function escapeMarkup(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Decode HTML character references in untrusted prose exactly once while
 * preserving every other character literally.
 *
 * Only the isolated references are left for the parser to resolve; the text
 * between them is escaped first, so source HTML can never become an element.
 * All references are decoded in a single inert parse, avoiding the per-entity
 * parser cost that let a small payload freeze the renderer.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  let escaped = "";
  let lastIndex = 0;
  for (const match of text.matchAll(HTML_ENTITY)) {
    const index = match.index ?? 0;
    escaped += escapeMarkup(text.slice(lastIndex, index));
    escaped += match[0];
    lastIndex = index + match[0].length;
  }
  escaped += escapeMarkup(text.slice(lastIndex));
  const decoded = new DOMParser().parseFromString(escaped, "text/html").body.textContent;
  return decoded ?? text;
}

/**
 * Validate an external link target from untrusted Markdown and return its
 * normalized absolute URL, or `null` when it must stay plain text.
 *
 * Character references are decoded before validation so an encoded authority
 * such as `https://trusted&#x40;evil` cannot masquerade as a safe link. The
 * accepted set mirrors the native opener boundary; a model-supplied path is
 * never a valid target and therefore can never open a local file.
 */
export function safeConversationLink(rawHref: string): string | null {
  if (typeof rawHref !== "string") return null;
  const decoded = decodeHtmlEntities(rawHref);
  if (decoded.length === 0 || decoded.length > MAX_SAFE_LINK_CHARS) return null;
  if (CONTROL_CHARACTER.test(decoded)) return null;
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (scheme !== "mailto" && url.hostname === "") return null;
  return url.href;
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
