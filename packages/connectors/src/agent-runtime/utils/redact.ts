/**
 * Secret Redaction Utilities.
 *
 * Scans strings and JSON objects for common patterns of API keys, bearer tokens,
 * passwords, and other credentials, masking them with `[REDACTED]`. Pattern
 * vocabulary lives in `@mivlet/protocol` so TypeScript and Rust cannot drift.
 */

import {
  isSensitiveSecretKey,
  redactSecretText,
  SECRET_REDACTED
} from "@mivlet/protocol";

/**
 * Scan a string for sensitive credentials and redact them.
 */
export function redactSecretsFromString(str: string): string {
  return redactSecretText(str);
}

/**
 * Recursively clone a structure and redact any sensitive keys or string values.
 */
export function redactSecretsFromObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return redactSecretsFromString(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecretsFromObject(item)) as unknown as T;
  }

  if (typeof obj === "object") {
    const redactedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveSecretKey(key)) {
        redactedObj[key] = SECRET_REDACTED;
      } else {
        redactedObj[key] = redactSecretsFromObject(value);
      }
    }
    return redactedObj as T;
  }

  return obj;
}
