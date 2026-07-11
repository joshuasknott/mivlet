import { describe, expect, it } from "vitest";
import {
  describeBackendError,
  isBackendErrorCode,
  isConfigurationErrorCode
} from "./backend-errors";

describe("describeBackendError", () => {
  it("classifies a bad/expired key as a configuration error, never retryable", () => {
    const result = describeBackendError("HTTP 401", "authentication", false);
    expect(result.tone).toBe("danger");
    expect(result.retryable).toBe(false);
    expect(result.message.toLowerCase()).toContain("api key");
    expect(result.message).toContain("Settings");
    // The raw provider detail is preserved.
    expect(result.message).toContain("HTTP 401");
  });

  it("classifies rate-limited / provider-unavailable / transport as transient runtime errors", () => {
    for (const code of ["rate-limited", "provider-unavailable", "transport"] as const) {
      const result = describeBackendError("transient", code, true);
      expect(result.tone).toBe("caution");
      expect(result.retryable).toBe(true);
      // Runtime errors must not point the user at their API key.
      expect(result.message.toLowerCase()).not.toContain("api key");
    }
  });

  it("explains entitlement failures as account access problems", () => {
    const result = describeBackendError("HTTP 403", "entitlement", false);
    expect(result).toMatchObject({ tone: "danger", retryable: false });
    expect(result.message.toLowerCase()).toContain("doesn't have access");
    expect(result.message.toLowerCase()).toContain("plan");
  });

  it("distinguishes offline and timeout failures", () => {
    const offline = describeBackendError("DNS failed", "offline", true);
    const timeout = describeBackendError("deadline elapsed", "timeout", true);
    expect(offline.message.toLowerCase()).toContain("offline");
    expect(timeout.message.toLowerCase()).toContain("too long");
    expect(offline.retryable).toBe(true);
    expect(timeout.retryable).toBe(true);
  });

  it("classifies response-too-large as a non-retryable runtime limit", () => {
    const result = describeBackendError("too big", "response-too-large", false);
    expect(result.tone).toBe("caution");
    expect(result.retryable).toBe(false);
    expect(result.message.toLowerCase()).toContain("size limit");
  });

  it("classifies invalid-request as a non-retryable provider rejection", () => {
    const result = describeBackendError("bad shape", "invalid-request", false);
    expect(result.tone).toBe("danger");
    expect(result.retryable).toBe(false);
    expect(result.message.toLowerCase()).toContain("rejected the request");
  });

  it("falls back to a generic runtime heading when no structured code is present", () => {
    // Unclassified backends still surface a useful message, treated as runtime.
    const result = describeBackendError("something broke");
    expect(result.message).toBe("something broke");
    expect(result.tone).toBe("caution");
    expect(result.retryable).toBe(true);
  });

  it("ignores an unrecognized code rather than misclassifying it", () => {
    const result = describeBackendError("unknown", "not-a-real-code", false);
    expect(result.message).toBe("unknown");
    expect(result.tone).toBe("caution");
  });

  it("keeps a default message when the raw message is empty", () => {
    const result = describeBackendError("");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("isBackendErrorCode", () => {
  it("accepts the boundary's transport control codes", () => {
    expect(isBackendErrorCode("authentication")).toBe(true);
    expect(isBackendErrorCode("transport")).toBe(true);
    expect(isBackendErrorCode("provider-unavailable")).toBe(true);
    expect(isBackendErrorCode("entitlement")).toBe(true);
    expect(isBackendErrorCode("offline")).toBe(true);
    expect(isBackendErrorCode("timeout")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isBackendErrorCode("nope")).toBe(false);
    expect(isBackendErrorCode(undefined)).toBe(false);
    expect(isBackendErrorCode(null)).toBe(false);
  });
});

describe("isConfigurationErrorCode", () => {
  it("treats authentication as a configuration problem", () => {
    expect(isConfigurationErrorCode("authentication")).toBe(true);
    expect(isConfigurationErrorCode("entitlement")).toBe(true);
  });

  it("treats runtime codes as non-configuration", () => {
    expect(isConfigurationErrorCode("provider-unavailable")).toBe(false);
    expect(isConfigurationErrorCode("transport")).toBe(false);
    expect(isConfigurationErrorCode("rate-limited")).toBe(false);
  });
});
