import { describe, expect, it } from "vitest";
import { redactHostedProcessOutput } from "./secret-redact";

describe("hosted process output redaction", () => {
  it("redacts credential-shaped stdout before it can become tool output", () => {
    expect(redactHostedProcessOutput("token=leaked-refresh-token")).toContain("[REDACTED]");
    expect(redactHostedProcessOutput("token=leaked-refresh-token")).not.toContain("leaked-refresh-token");
    expect(redactHostedProcessOutput("Authorization: Bearer abcdefghij1234567890")).not.toContain("abcdefghij");
  });

  it("omits output when a secret marker survives redaction", () => {
    expect(redactHostedProcessOutput("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv")).toBe(
      "[output omitted: secret-shaped content]"
    );
  });
});
