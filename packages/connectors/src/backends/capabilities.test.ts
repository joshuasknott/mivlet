import { describe, expect, it } from "vitest";
import { resolveCapabilities } from "./capabilities";

describe("managed agent capabilities", () => {
  it.each(["claude-agent", "opencode-server"] as const)(
    "%s advertises its mediated tool surface only when connected",
    (backendType) => {
      expect(resolveCapabilities(backendType, "connected")).toEqual(
        expect.arrayContaining([
          "streaming",
          "tool-requests",
          "approvals",
          "file-changes",
          "cancellation",
        ]),
      );
      expect(resolveCapabilities(backendType, "sign-in-required")).toEqual([]);
    },
  );
});
