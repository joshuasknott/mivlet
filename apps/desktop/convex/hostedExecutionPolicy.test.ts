import { describe, expect, it } from "vitest";
import {
  hostedComputerId,
  hostedRunnerBaseUrl,
  requireHostedIdentifier,
  validateHostedComputerSnapshot
} from "./hostedExecutionPolicy";

describe("hosted execution coordination policy", () => {
  it("derives stable opaque computer ids without exposing workspace or agent ids", () => {
    const first = hostedComputerId("workspace:alpha", "agent:research");
    expect(first).toMatch(/^fc-[a-f0-9]{16}$/);
    expect(first).toBe(hostedComputerId("workspace:alpha", "agent:research"));
    expect(first).not.toContain("alpha");
    expect(first).not.toBe(hostedComputerId("workspace:alpha", "agent:writer"));
  });

  it("rejects control characters and unbounded identifiers", () => {
    expect(() => requireHostedIdentifier("bad id", "Agent id")).toThrow(/invalid/i);
    expect(() => requireHostedIdentifier(`agent:${"a".repeat(200)}`, "Agent id")).toThrow(/invalid/i);
  });

  it("accepts only a matching, bounded runner snapshot", () => {
    const snapshot = {
      computerId: "fc-0123456789abcdef",
      lifecycle: "ready",
      runtimeActive: true,
      keepAlive: true,
      generation: 1,
      updatedAt: "2026-08-24T12:00:00.000Z"
    };
    expect(validateHostedComputerSnapshot(snapshot, snapshot.computerId)).toEqual(snapshot);
    expect(() => validateHostedComputerSnapshot({ ...snapshot, computerId: "other" }, snapshot.computerId)).toThrow(/invalid/i);
    expect(() => validateHostedComputerSnapshot({ ...snapshot, lifecycle: "magic" }, snapshot.computerId)).toThrow(/invalid/i);
  });

  it("accepts only a root HTTPS runner origin", () => {
    expect(hostedRunnerBaseUrl("https://runner.example.com").toString()).toBe("https://runner.example.com/");
    for (const value of [
      "http://runner.example.com",
      "https://user:secret@runner.example.com",
      "https://runner.example.com/private",
      "https://runner.example.com/?token=secret",
      "https://localhost"
    ]) {
      expect(() => hostedRunnerBaseUrl(value)).toThrow(/invalid/i);
    }
  });
});
