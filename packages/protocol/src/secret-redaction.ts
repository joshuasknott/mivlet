/**
 * Shared secret-redaction vocabulary for TypeScript and Rust.
 *
 * The JSON fixture is the source of truth. TypeScript compiles the patterns
 * here; native code `include_str!`s the same file so a marker present in one
 * layer cannot be absent from the other.
 */

import vocabulary from "./secret-redaction.json" with { type: "json" };

export interface SecretRedactionCase {
  id: string;
  input: string;
  looksSecret: boolean;
  mustNotContain: string[];
}

interface SecretRedactionVocabulary {
  redacted: string;
  inlinePatterns: Array<{
    id: string;
    pattern: string;
    flags: string;
    replacement: string;
  }>;
  survivingPatterns: string[];
  substringMarkers: string[];
  sensitiveKeyStems: string[];
  sensitiveKeyPattern: string;
  cases: SecretRedactionCase[];
}

const SECRET_REDACTION_VOCABULARY = vocabulary as SecretRedactionVocabulary;
export const SECRET_REDACTED = SECRET_REDACTION_VOCABULARY.redacted;
const SECRET_SUBSTRING_MARKERS = SECRET_REDACTION_VOCABULARY.substringMarkers;
export const SECRET_REDACTION_CASES = SECRET_REDACTION_VOCABULARY.cases;

const INLINE_PATTERNS = SECRET_REDACTION_VOCABULARY.inlinePatterns.map((pattern) => ({
  regex: new RegExp(pattern.pattern, pattern.flags),
  replacement: pattern.replacement
}));

const SURVIVING_PATTERNS = SECRET_REDACTION_VOCABULARY.survivingPatterns.map(
  (pattern) => new RegExp(pattern, "i")
);

const SENSITIVE_KEY = new RegExp(SECRET_REDACTION_VOCABULARY.sensitiveKeyPattern, "i");

/**
 * Scan a string for known credential shapes and replace them in place.
 * Does not omit the surrounding text; write boundaries that must fail closed
 * should call {@link secretMarkerSurvives} on the result.
 */
export function redactSecretText(value: string): string {
  if (!value) return value;
  let redacted = value;
  for (const pattern of INLINE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    redacted = redacted.replace(pattern.regex, pattern.replacement);
  }
  return redacted;
}

/** True when a known secret marker is still present after surgical redaction. */
export function secretMarkerSurvives(value: string): boolean {
  return SURVIVING_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/** True when an object key name is always treated as a credential field. */
export function isSensitiveSecretKey(key: string): boolean {
  SENSITIVE_KEY.lastIndex = 0;
  return SENSITIVE_KEY.test(key);
}

/** Case-insensitive substring match against the shared marker list. */
export function looksLikeSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return SECRET_SUBSTRING_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}
