export function toRuntimeError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  const candidate = error as {
    message?: unknown;
    code?: unknown;
    retryable?: unknown;
  };
  const message =
    typeof candidate?.message === "string" && candidate.message.trim()
      ? candidate.message
      : typeof error === "string" && error.trim()
        ? error
        : "Mivlet runtime request failed.";

  const runtimeError = new Error(message) as Error & {
    code?: string;
    retryable?: boolean;
  };
  if (typeof candidate?.code === "string") {
    runtimeError.code = candidate.code;
  }
  if (typeof candidate?.retryable === "boolean") {
    runtimeError.retryable = candidate.retryable;
  }
  return runtimeError;
}
