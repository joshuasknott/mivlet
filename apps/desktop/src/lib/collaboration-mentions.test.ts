import { describe, expect, it } from "vitest";
import {
  displayWorkspaceMentions,
  resolveWorkspaceMentions,
  workspaceMentionToken,
} from "./collaboration-mentions";

describe("workspace assignment mentions", () => {
  const agents = [
    { id: "test", name: "Test" },
    { id: "test-two", name: "Test" },
    { id: "research", name: "Researcher" },
  ];

  it("persists a selected recipient by stable ID and allows renames", () => {
    const token = workspaceMentionToken({ id: "test", name: "Old Name" });
    expect(resolveWorkspaceMentions(`${token} review this`, [{ ...agents[0], name: "Renamed" }])).toMatchObject({
      recipientIds: ["test"],
      assignment: "review this",
      shouldExecute: true,
    });
    const escaped = workspaceMentionToken({ id: "bracket", name: "A]gent" });
    expect(resolveWorkspaceMentions(`${escaped} inspect`, [{ id: "bracket", name: "A]gent" }]).shouldExecute).toBe(true);
  });

  it("fails closed for ambiguous, removed, quoted, or reference-only recipients", () => {
    expect(resolveWorkspaceMentions("@Test review this", agents).shouldExecute).toBe(false);
    expect(resolveWorkspaceMentions("@missing review this", agents).errors).toHaveLength(1);
    expect(resolveWorkspaceMentions("@[Test](agent:missing review this", agents).errors).toHaveLength(1);
    expect(resolveWorkspaceMentions('"@research review this"', agents).shouldExecute).toBe(false);
    expect(resolveWorkspaceMentions("@research", agents).shouldExecute).toBe(false);
    expect(resolveWorkspaceMentions("@tes review this", agents).errors).toHaveLength(1);
  });

  it("resolves exact multiword names without prefix guessing", () => {
    const named = [{ id: "ada", name: "Ada Lovelace" }];
    expect(resolveWorkspaceMentions("@Ada Lovelace inspect", named).recipientIds).toEqual(["ada"]);
    expect(resolveWorkspaceMentions("@Ad inspect", named).shouldExecute).toBe(false);
  });

  it("accepts several distinct leading recipients", () => {
    const result = resolveWorkspaceMentions("@test-two @research compare these", agents);
    expect(result.recipientIds).toEqual(["test-two", "research"]);
    expect(result.assignment).toBe("compare these");
    expect(result.shouldExecute).toBe(true);
  });

  it("keeps known plugin references from becoming invalid agent recipients", () => {
    expect(resolveWorkspaceMentions("@computer open the page", agents, ["computer"])).toMatchObject({
      recipientIds: [],
      errors: [],
      shouldExecute: false,
    });
    expect(resolveWorkspaceMentions("@research @computer review", agents, ["computer"]).recipientIds).toEqual(["research"]);
    expect(resolveWorkspaceMentions("@computer review", [{ id: "agent-c", name: "Computer" }], ["computer"]).errors).toHaveLength(1);
  });

  it("formats stable mentions for display while retaining escaped labels", () => {
    expect(displayWorkspaceMentions("Ask @[Renamed](agent:test) and @[A\\]gent](agent:bracket)"))
      .toBe("Ask @Renamed and @A]gent");
  });
});
