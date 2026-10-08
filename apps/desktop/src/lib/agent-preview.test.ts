import { describe, expect, it } from "vitest";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import { latestAgentReply } from "./agent-preview";
const work = (text: string, createdAt: string) => ({ outputs: [{ text, createdAt }] }) as CollaborationWorkItem;
describe("agent sidebar reply", () => {
  it("keeps generated source out of the bounded sidebar preview", () => {
    expect(latestAgentReply([work('Here is the comparison.\n```openui\nroot = Table("Data", [], [])\n```', "2026-10-08")])).toBe("Here is the comparison. Interactive response");
    expect(latestAgentReply([work("x".repeat(1_000), "2026-10-08")])).toHaveLength(240);
  });
  it("leaves agents without replies blank", () => {
    expect(latestAgentReply([])).toBe("");
    expect(latestAgentReply([work("  ", "2026-09-16")])).toBe("");
  });
  it("uses the newest response across work items and normalises line breaks", () => {
    expect(latestAgentReply([
      work("Latest reply\nwith detail", "2026-09-16T12:00:00Z"),
      work("Older reply", "2026-09-15T12:00:00Z"),
      { outputs: [], status: "running", prompt: "User prompt" } as unknown as CollaborationWorkItem,
    ])).toBe("Latest reply with detail");
  });
});
