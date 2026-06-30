/**
 * Provider error classification for the agent UI.
 *
 * The Rust boundary emits structured transport control events with a machine-
 * readable `code` (`authentication` | `rate-limited` | `provider-unavailable` |
 * `invalid-request` | `transport` | `response-too-large`) and a `retryable`
 * flag. The agent loop propagates these onto the `error` BackendAgentEvent.
 *
 * Without classification, a *configuration* error (a bad or expired API key →
 * `authentication`) is indistinguishable from a *runtime* failure
 * (`provider-unavailable`, `transport`, `rate-limited`). This module is the
 * single place that turns the structured code into user-facing copy so the two
 * are visually and textually distinct — configuration problems point the user
 * at their key in Settings; runtime problems suggest retrying.
 *
 * Pure (no React, no transport) so the classification is unit-testable.
 */

/**
 * The closed set of error codes the native-API Rust boundary emits on its
 * transport control channel (`__fableTransport`). Kept here as a type so the UI
 * classification stays in lockstep with the boundary vocabulary. A code outside
 * this set is treated as a generic runtime failure.
 */
export type BackendErrorCode =
  | "authentication"
  | "rate-limited"
  | "provider-unavailable"
  | "invalid-request"
  | "transport"
  | "response-too-large";

/** True for codes that originate from the boundary's transport control events. */
export function isBackendErrorCode(code: unknown): code is BackendErrorCode {
  return (
    code === "authentication" ||
    code === "rate-limited" ||
    code === "provider-unavailable" ||
    code === "invalid-request" ||
    code === "transport" ||
    code === "response-too-large"
  );
}

/**
 * Whether a code represents a *configuration* problem (the user's stored
 * credential or request shape) rather than a transient *runtime* failure.
 * Configuration errors are not fixed by retrying — the user must change
 * something (re-add a key, adjust the request).
 */
export function isConfigurationErrorCode(code: BackendErrorCode): boolean {
  return code === "authentication";
}

export interface DescribedBackendError {
  /** The user-facing message, headed by a classification sentence. */
  message: string;
  /** Visual tone: danger for configuration, caution for transient runtime. */
  tone: "danger" | "caution";
  /** Whether retrying may succeed (false for configuration errors). */
  retryable: boolean;
}

/**
 * Turn a raw provider error into user-facing copy that distinguishes
 * configuration errors from runtime/provider failures.
 *
 * The original provider message is always preserved (providers often include
 * useful detail — a quota name, a malformed field) and appended after the
 * classification sentence. When no structured code is present the message is
 * returned as-is under a generic runtime heading so unclassified backends still
 * surface something useful.
 */
export function describeBackendError(
  rawMessage: string,
  code?: string,
  retryable?: boolean
): DescribedBackendError {
  const message = rawMessage || "Provider request failed.";
  if (!isBackendErrorCode(code)) {
    return {
      message,
      tone: "caution",
      retryable: retryable ?? true
    };
  }

  if (code === "authentication") {
    return {
      message: `Your API key was rejected or has expired. Check the key for this provider in Settings and reconnect. (${message})`,
      tone: "danger",
      retryable: false
    };
  }
  if (code === "rate-limited") {
    return {
      message: `The provider is rate-limiting requests. Try again shortly. (${message})`,
      tone: "caution",
      retryable: true
    };
  }
  if (code === "provider-unavailable") {
    return {
      message: `The provider is unavailable right now. Try again in a moment. (${message})`,
      tone: "caution",
      retryable: true
    };
  }
  if (code === "transport") {
    return {
      message: `Fable couldn't reach the provider. Check your connection and retry. (${message})`,
      tone: "caution",
      retryable: true
    };
  }
  if (code === "response-too-large") {
    return {
      message: `The provider's response exceeded Fable's size limit. (${message})`,
      tone: "caution",
      retryable: false
    };
  }
  // invalid-request: the request shape was rejected. Not safely retryable as-is.
  return {
    message: `The provider rejected the request. (${message})`,
    tone: "danger",
    retryable: false
  };
}
