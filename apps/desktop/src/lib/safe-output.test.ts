import { describe, expect, it } from "vitest";
import {
  formatForInspection,
  redactSecrets,
  tryParseJson,
  MAX_SAFE_OUTPUT_CHARS,
  TRUNCATION_MARKER
} from "./safe-output";

/**
 * Safe connector-output inspection. The invariant under test: an arbitrary
 * connector/tool/step value can never produce a secret in the rendered text,
 * regardless of shape — nested objects, JSON strings, or inline credentials.
 */

describe("redactSecrets", () => {
  it("redacts known credential keys at any depth", () => {
    const input = {
      ok: true,
      apiKey: "sk-live-1234567890",
      nested: { token: "abc123", safe: "keep" },
      list: [{ password: "hunter2" }]
    };
    expect(redactSecrets(input)).toEqual({
      ok: true,
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]", safe: "keep" },
      list: [{ password: "[REDACTED]" }]
    });
  });

  it("scrubs inline credentials out of string values", () => {
    const input = "Authorization: Bearer abcdefghij1234567890 for sk-ant-12345678901234567890";
    expect(redactSecrets(input)).toBe("Authorization: [REDACTED] for [REDACTED]");
    expect(redactSecrets(input)).not.toContain("Bearer abcdef");
    expect(redactSecrets(input)).not.toContain("sk-ant-");
  });

  it("drops non-JSON-safe values (functions/symbols) to keep output stable", () => {
    const sym = Symbol("ignored");
    const input = { keep: 1, fn: () => "x", sym };
    expect(redactSecrets(input)).toEqual({ keep: 1, fn: undefined, sym: undefined });
  });
});

describe("formatForInspection", () => {
  it("pretty-prints objects as indented JSON", () => {
    const out = formatForInspection({ a: 1, b: { c: 2 } });
    expect(out).toContain('"a": 1');
    expect(out).toContain('"c": 2');
  });

  it("renders a JSON string value as structured output", () => {
    const out = formatForInspection('{"summary":"ok","items":[1,2]}');
    expect(out).toContain('"summary": "ok"');
    expect(out).toContain('"items"');
  });

  it("leaves a plain non-JSON string untouched", () => {
    expect(formatForInspection("just text")).toBe("just text");
  });

  it("never leaks a credential from a nested connector payload", () => {
    const out = formatForInspection({
      result: { connection: { api_key: "sk-leaked-1234567890123" } }
    });
    expect(out).not.toContain("sk-leaked");
    expect(out).toContain("[REDACTED]");
  });

  it("truncates very large output and marks it", () => {
    const huge = "x".repeat(MAX_SAFE_OUTPUT_CHARS * 2);
    const out = formatForInspection(huge);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_SAFE_OUTPUT_CHARS + TRUNCATION_MARKER.length + 1);
  });
});

describe("tryParseJson", () => {
  it("parses valid JSON and falls back to the raw string otherwise", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson("not json")).toBe("not json");
  });
});
