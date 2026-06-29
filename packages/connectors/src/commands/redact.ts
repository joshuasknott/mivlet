/**
 * Secret redaction for the /remember command path.
 *
 * The memory write boundary applies NO redaction today — free-text memory
 * values persist verbatim. This gate runs before a value reaches
 * promoteToMemory, refusing secret-shaped input so no secret lands in memory,
 * snapshots, logs, or exports. When a value is refused, the secret is NEVER
 * echoed back; the caller surfaces a generic message.
 *
 * Pure and transport-free, reusing the codebase's existing secret vocabulary
 * (the same markers as the Rust `redact_connector_text`).
 */

export interface RedactionResult {
  /** True when the input looks like a secret and must be refused. */
  refused: boolean;
  /** The safe value when not refused; a non-revealing placeholder when refused. */
  safe: string;
}

const SAFE_PLACEHOLDER = "";

// A label followed by an assignment connector. "is"/"are"/"was"/"'s" catch
// natural-language leaks ("the secret is 12345"); "=" / ":" catch key=value and
// header forms. Word boundaries keep ordinary words ("tokenize") from tripping.
const ASSIGN_CONNECTOR = "(?:\\s*(?:=|:)\\s*|\\s+(?:is|are|was|'s)\\b)";

const SECRET_LABEL_PATTERNS: RegExp[] = [
  new RegExp(`\\bauthorization\\b${ASSIGN_CONNECTOR}`, "i"),
  /\bbearer\b\s+/i,
  new RegExp(`\\bcookie\\b${ASSIGN_CONNECTOR}`, "i"),
  /\baccess[_\s-]?token\b/i,
  /\brefresh[_\s-]?token\b/i,
  /\bclient[_\s-]?secret\b/i,
  new RegExp(`\\bapi[_\\s-]?key\\b${ASSIGN_CONNECTOR}`, "i"),
  new RegExp(`\\bapi[_\\s-]?secret\\b${ASSIGN_CONNECTOR}`, "i"),
  new RegExp(`\\bpassword\\b${ASSIGN_CONNECTOR}`, "i"),
  new RegExp(`\\bpasswd\\b${ASSIGN_CONNECTOR}`, "i"),
  new RegExp(`\\bsecret\\b${ASSIGN_CONNECTOR}`, "i"),
  /\bprivate[_\s-]?key\b/i,
  /\bsession[_\s-]?token\b/i
];

// Known provider token shapes (high-signal prefixes).
const SECRET_SHAPE_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/
];

// A JWT: three base64url segments joined by dots, with realistic lengths.
const JWT_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

function looksLikeSecret(value: string): boolean {
  if (SECRET_LABEL_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  if (SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  const trimmed = value.trim();
  if (JWT_PATTERN.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Inspect a candidate memory value. Returns `{ refused: true }` (with a
 * non-revealing safe value) when the input looks like a secret; otherwise
 * returns the value unchanged.
 */
export function redactSecrets(value: string): RedactionResult {
  if (looksLikeSecret(value)) {
    return { refused: true, safe: SAFE_PLACEHOLDER };
  }
  return { refused: false, safe: value };
}
