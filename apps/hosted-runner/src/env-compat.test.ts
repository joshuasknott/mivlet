import { readMivletEnvValue, withLegacyFableEnv } from "@mivlet/protocol";
import { describe, expect, it } from "vitest";

describe("MIVLET_* / FABLE_* env dual-read", () => {
  it("reads a legacy FABLE_* alias when MIVLET_* is unset", () => {
    expect(readMivletEnvValue({ FABLE_HOSTED_RUNNER_API_KEY: "legacy-secret" }, "HOSTED_RUNNER_API_KEY"))
      .toBe("legacy-secret");
    expect(withLegacyFableEnv({ FABLE_HOSTED_RUNNER_SIGNING_KEY: "legacy-hmac" }).MIVLET_HOSTED_RUNNER_SIGNING_KEY)
      .toBe("legacy-hmac");
  });

  it("does not fall through when a MIVLET_* value is present, including empty", () => {
    expect(readMivletEnvValue({
      MIVLET_HOSTED_RUNNER_API_KEY: "",
      FABLE_HOSTED_RUNNER_API_KEY: "legacy-secret"
    }, "HOSTED_RUNNER_API_KEY")).toBe("");
    expect(withLegacyFableEnv({
      MIVLET_HOSTED_RUNNER_SIGNING_KEY: "",
      FABLE_HOSTED_RUNNER_SIGNING_KEY: "legacy-hmac"
    }).MIVLET_HOSTED_RUNNER_SIGNING_KEY).toBe("");
  });
});
