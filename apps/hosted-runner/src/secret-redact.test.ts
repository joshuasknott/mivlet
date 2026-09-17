import { describe, expect, it } from "vitest";
import { redactSecretText, SECRET_REDACTION_CASES, secretMarkerSurvives } from "@mivlet/protocol";
import { redactHostedProcessOutput } from "./secret-redact";

describe("hosted process output redaction", () => {
  it("redacts credential-shaped stdout before it can become tool output", () => {
    expect(redactHostedProcessOutput("token=leaked-refresh-token")).toContain("[REDACTED]");
    expect(redactHostedProcessOutput("token=leaked-refresh-token")).not.toContain("leaked-refresh-token");
    expect(redactHostedProcessOutput("Authorization: Bearer abcdefghij1234567890")).not.toContain("abcdefghij");
  });

  it("omits output when a secret marker survives surgical redaction", () => {
    expect(redactHostedProcessOutput("export GITHUB_TOKEN=ghp_short")).toBe(
      "[output omitted: secret-shaped content]"
    );
  });

  it("keeps surrounding stdout when a GitHub token can be redacted in place", () => {
    const output = redactHostedProcessOutput("ok ghp_abcdefghijklmnopqrstuvwx1234567890 done");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234567890");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("ok ");
    expect(output).toContain(" done");
  });

  for (const fixture of SECRET_REDACTION_CASES) {
    it(`shared fixture ${fixture.id} cannot leak through hosted stdout`, () => {
      const output = redactHostedProcessOutput(fixture.input);
      expect(output).toBeDefined();
      for (const leaked of fixture.mustNotContain) {
        expect(output).not.toContain(leaked);
      }
      if (fixture.looksSecret) {
        const redacted = redactSecretText(fixture.input);
        if (secretMarkerSurvives(redacted)) {
          expect(output).toBe("[output omitted: secret-shaped content]");
        }
      } else {
        expect(output).toBe(fixture.input);
      }
    });
  }
});
