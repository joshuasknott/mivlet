import { describe, expect, it } from "vitest";
import {
  SECRET_CONTENT_OMITTED,
  SECRET_REDACTED,
  SECRET_REDACTION_CASES
} from "@fable/protocol";
import { redactKnowledgeChunk, redactKnowledgeText } from "./redact";

describe("knowledge secret redaction", () => {
  for (const fixture of SECRET_REDACTION_CASES) {
    it(`scrubs ${fixture.id} before store or retrieve`, () => {
      const redacted = redactKnowledgeText(fixture.input);
      for (const leaked of fixture.mustNotContain) {
        expect(redacted).not.toContain(leaked);
      }
      if (fixture.looksSecret) {
        expect(
          redacted === SECRET_REDACTED ||
            redacted === SECRET_CONTENT_OMITTED ||
            !redacted.includes(fixture.mustNotContain[0] ?? "")
        ).toBe(true);
      } else {
        expect(redacted).toBe(fixture.input);
      }
    });
  }

  it("rehashes a chunk after surgical redaction", () => {
    const leaked = "sk-12345678901234567890abc123";
    const chunk = redactKnowledgeChunk({
      id: "s#0",
      sourceId: "s",
      ordinal: 0,
      text: `Launch plan. my key is ${leaked}`,
      contentHash: "original",
      charStart: 0,
      charEnd: 40
    });
    expect(chunk.text).not.toContain(leaked);
    expect(chunk.text).toContain("[REDACTED]");
    expect(chunk.contentHash).not.toBe("original");
    expect(chunk.charStart).toBe(0);
    expect(chunk.charEnd).toBe(40);
  });
});
