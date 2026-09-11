import { describe, expect, it } from "vitest";
import {
  formatForInspection,
  redactSecrets,
  tryParseJson,
  decodeHtmlEntities,
  safeConversationLink,
  MAX_SAFE_OUTPUT_CHARS,
  MAX_SAFE_LINK_CHARS,
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
      nested: { token: "abc123", secretToken: "def456", safe: "keep" },
      list: [{ password: "hunter2" }]
    };
    expect(redactSecrets(input)).toEqual({
      ok: true,
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]", secretToken: "[REDACTED]", safe: "keep" },
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

/**
 * Untrusted prose may contain encoded character references. Decoding must be
 * exact-once, must never turn markup into elements, and must stay linear so a
 * payload cannot freeze the renderer.
 */
describe("decodeHtmlEntities", () => {
  it("decodes named and numeric references once", () => {
    expect(decodeHtmlEntities("A &amp; B &#65; &#x42;")).toBe("A & B A B");
  });

  it("never double-decodes a reference", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("keeps source HTML as literal text", () => {
    expect(decodeHtmlEntities("&lt;img src=x onerror=alert(1)&gt;")).toBe("<img src=x onerror=alert(1)>");
    expect(decodeHtmlEntities("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
  });

  it("leaves malformed or incomplete references untouched", () => {
    expect(decodeHtmlEntities("&zzzznotreal; &amp &;")).toBe("&zzzznotreal; &amp &;");
  });

  it("short-circuits text without references", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
    expect(decodeHtmlEntities("")).toBe("");
  });

  it("decodes repeated references without per-entity work blowing up", () => {
    const decoded = decodeHtmlEntities("&amp;".repeat(20_000));
    expect(decoded).toBe("&".repeat(20_000));
  });
});

/**
 * The native opener accepts only http(s)/mailto without credentials. The
 * renderer must reach the same conclusion from the decoded target, so an
 * encoded authority can never masquerade as a safe link and a model path can
 * never open a local file.
 */
describe("safeConversationLink", () => {
  it("normalizes accepted web and email targets", () => {
    expect(safeConversationLink("https://example.com/report?q=a&b=c")).toContain("https://example.com/report");
    expect(safeConversationLink("http://localhost:1420")).toBe("http://localhost:1420/");
    expect(safeConversationLink("mailto:person@example.com")).toBe("mailto:person@example.com");
  });

  it("rejects dangerous and local schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/System32/calc.exe",
      "ms-settings:privacy",
      "C:\\Users\\me\\.ssh\\id_rsa",
      "\\\\attacker\\share\\payload.exe",
      "//evil.example",
      "JaVaScRiPt:alert(1)"
    ]) {
      expect(safeConversationLink(value)).toBeNull();
    }
  });

  it("rejects a scheme hidden behind a character reference", () => {
    expect(safeConversationLink("jav&#x61;script:alert(1)")).toBeNull();
    expect(safeConversationLink("&#106;avascript:alert(1)")).toBeNull();
  });

  it("rejects a safe-looking authority that decodes to a different host", () => {
    expect(safeConversationLink("https://trusted.example&#x40;evil.example")).toBeNull();
    expect(safeConversationLink("https://trusted.example@evil.example")).toBeNull();
  });

  it("rejects embedded credentials and control characters", () => {
    expect(safeConversationLink("https://user:pass@example.com")).toBeNull();
    expect(safeConversationLink("https://example.com\u0000")).toBeNull();
    expect(safeConversationLink("https://example.com&#13;&#10;X-Injected:1")).toBeNull();
  });

  it("rejects targets beyond the opener's length bound", () => {
    expect(safeConversationLink(`https://example.com/${"a".repeat(MAX_SAFE_LINK_CHARS)}`)).toBeNull();
    expect(safeConversationLink("")).toBeNull();
    expect(safeConversationLink("not a url")).toBeNull();
  });
});
