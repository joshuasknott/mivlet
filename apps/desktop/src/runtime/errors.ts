export function toRuntimeError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const runtimeError = new Error(error.message) as Error & {
      code?: string;
      retryable?: boolean;
    };
    if ("code" in error && typeof error.code === "string") {
      runtimeError.code = error.code;
    }
    if ("retryable" in error && typeof error.retryable === "boolean") {
      runtimeError.retryable = error.retryable;
    }
    return runtimeError;
  }

  return new Error(
    typeof error === "string" ? error : "Mivlet runtime request failed.",
  );
}
