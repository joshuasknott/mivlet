/**
 * Secret Redaction Utilities.
 *
 * Scans strings and JSON objects for common patterns of API keys, bearer tokens,
 * passwords, and other credentials, masking them with `[REDACTED]`.
 */

/**
 * Scan a string for sensitive credentials and redact them.
 */
export function redactSecretsFromString(str: string): string {
  if (!str) return str;
  let redacted = str;

  // OpenAI API keys
  redacted = redacted.replace(/\bsk-[a-zA-Z0-9_\-]{20,}\b/g, "[REDACTED]");
  // Anthropic API keys
  redacted = redacted.replace(/\bsk-ant-[a-zA-Z0-9_\-]{20,}\b/g, "[REDACTED]");
  // Gemini API keys
  redacted = redacted.replace(/\bAIzaSy[a-zA-Z0-9_\-]{33}\b/g, "[REDACTED]");
  // Bearer tokens
  redacted = redacted.replace(/\bBearer\s+[a-zA-Z0-9\-._~+/]{10,}(?:=*)?\b/gi, "Bearer [REDACTED]");

  // Key-value pairs like token=xxx, api_key: "xxx"
  // Group 1: key name + assignment separator + optional opening quote
  // Group 2: optional opening quote captured
  // Group 3: the secret value (at least 6 characters)
  // Group 4: closing quote matching Group 2
  redacted = redacted.replace(
    /(\b(?:api[-_]?key|token|password|cookie|authorization|secret|credential|session[-_]?token)\s*(?:[=:]|:\s*)\s*(["']?))([a-zA-Z0-9\-._~+/%=]{6,})(\2)/gi,
    "$1[REDACTED]$4"
  );

  return redacted;
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
    const redactedObj: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const isSensitiveKey =
        /^(api[-_]?key|token|password|passwd|cookie|authorization|secret|credential|session[-_]?token|access[-_]?token|refresh[-_]?token|secret[-_]?token|client[-_]?secret|private[-_]?key)$/i.test(
          key
        );
      if (isSensitiveKey) {
        redactedObj[key] = "[REDACTED]";
      } else {
        redactedObj[key] = redactSecretsFromObject(value);
      }
    }
    return redactedObj as T;
  }

  return obj;
}
