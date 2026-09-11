import { describe, expect, it } from "vitest";
import { toRuntimeError } from "./errors";

type ClassifiedError = Error & { code?: string; retryable?: boolean };

function classified(error: unknown): ClassifiedError {
  return toRuntimeError(error) as ClassifiedError;
}

describe("toRuntimeError", () => {
  it("passes Error instances through unchanged", () => {
    const error = new Error("Native command failed.");
    expect(toRuntimeError(error)).toBe(error);
  });

  it("preserves structured code and retryable on Error subclasses", () => {
    class StructuredError extends Error {
      code: string;
      retryable: boolean;
      constructor() {
        super("Provider request failed.");
        this.code = "cancelled";
        this.retryable = false;
      }
    }
    const error = new StructuredError();
    expect(toRuntimeError(error)).toBe(error);
    expect(classified(error).code).toBe("cancelled");
    expect(classified(error).retryable).toBe(false);
  });

  it("wraps objects with a usable message, keeping code and retryable", () => {
    const error = classified({
      message: "Hosted runner is unavailable.",
      code: "provider-unavailable",
      retryable: true,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Hosted runner is unavailable.");
    expect(error.code).toBe("provider-unavailable");
    expect(error.retryable).toBe(true);
  });

  it("wraps plain strings", () => {
    const error = classified("Temporary disk read failure");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Temporary disk read failure");
    expect(error.code).toBeUndefined();
  });

  it("keeps code and retryable when a rejection has no usable message", () => {
    const error = classified({ code: "cancelled", retryable: false });
    expect(error.message).toBe("Mivlet runtime request failed.");
    expect(error.code).toBe("cancelled");
    expect(error.retryable).toBe(false);
  });

  it("never yields a blank message", () => {
    expect(classified({ message: "" }).message).toBe(
      "Mivlet runtime request failed.",
    );
    expect(classified({ message: "   " }).message).toBe(
      "Mivlet runtime request failed.",
    );
    expect(classified("").message).toBe("Mivlet runtime request failed.");
  });

  it("falls back to the generic message for unusable rejections", () => {
    for (const value of [null, undefined, 42, true, {}, { message: 7 }]) {
      const error = classified(value);
      expect(error.message).toBe("Mivlet runtime request failed.");
      expect(error.code).toBeUndefined();
    }
  });

  it("ignores malformed code and retryable fields", () => {
    const error = classified({
      message: "Failed.",
      code: 42,
      retryable: "yes",
    });
    expect(error.message).toBe("Failed.");
    expect(error.code).toBeUndefined();
    expect(error.retryable).toBeUndefined();
  });
});
