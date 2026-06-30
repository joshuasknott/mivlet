import type { BackendAgentEvent } from "@fable/protocol";
import { redactSecretsFromString } from "./redact";

export interface BackendErrorMetadata {
  message: string;
  code: string;
  retryable: boolean;
}

export class BackendRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = "BackendRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function classifyBackendError(
  message: string
): Pick<BackendErrorMetadata, "code" | "retryable"> {
  if (
    /auth|unauthor|forbidden|401|403|credential|sign[- ]?in|login|token|api[-_ ]?key|invalid key|bad key/i.test(
      message
    )
  ) {
    return { code: "authentication", retryable: false };
  }
  if (/rate.?limit|quota|429/i.test(message)) {
    return { code: "rate-limited", retryable: true };
  }
  if (/cancel/i.test(message)) {
    return { code: "cancelled", retryable: false };
  }
  if (
    /timeout|timed out|temporar|offline|unavailable|overload|connection|disconnect|network|5\d\d/i.test(
      message
    )
  ) {
    return { code: "provider-unavailable", retryable: true };
  }
  if (/invalid|malformed|unsupported|too large|exceed/i.test(message)) {
    return { code: "invalid-request", retryable: false };
  }
  return { code: "backend-failed", retryable: false };
}

function metadataFromUnknown(error: unknown, fallbackMessage: string): BackendErrorMetadata {
  const candidate = error as { message?: unknown; code?: unknown; retryable?: unknown };
  const rawMessage =
    typeof candidate?.message === "string" && candidate.message.trim()
      ? candidate.message
      : fallbackMessage;
  const classified = classifyBackendError(rawMessage);
  return {
    message: redactSecretsFromString(rawMessage),
    code:
      typeof candidate?.code === "string" && candidate.code.trim()
        ? candidate.code
        : classified.code,
    retryable:
      typeof candidate?.retryable === "boolean" ? candidate.retryable : classified.retryable
  };
}

export function normalizeBackendErrorEvent(
  event: Extract<BackendAgentEvent, { type: "error" }>
): Extract<BackendAgentEvent, { type: "error" }> {
  const metadata = metadataFromUnknown(event, event.message);
  return {
    type: "error",
    message: metadata.message,
    code: event.code ?? metadata.code,
    retryable: event.retryable ?? metadata.retryable
  };
}

export function backendErrorEvent(
  error: unknown,
  fallbackMessage: string
): Extract<BackendAgentEvent, { type: "error" }> {
  const metadata = metadataFromUnknown(error, fallbackMessage);
  return {
    type: "error",
    message: metadata.message,
    code: metadata.code,
    retryable: metadata.retryable
  };
}
