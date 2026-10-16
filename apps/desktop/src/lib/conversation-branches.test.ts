import { describe, expect, it } from "vitest";
import {
  branchActionBlockReason,
  branchHasMissingAncestor,
  branchHeads,
  branchInputMessageId,
  branchSiblings,
  buildConversationBranchTree,
  visibleConversationBranch,
} from "./conversation-branches";

function view(
  id: string,
  sequence: number,
  parentMessageId?: string,
  kind: "user" | "assistant" = "assistant",
  runId?: string,
) {
  return {
    message: {
      id,
      sequence,
      kind,
      parentMessageId,
      previousMessageId: parentMessageId,
      ...(runId ? { runId } : {}),
    },
  } as never;
}

describe("conversation branch persistence", () => {
  const views = [view("u1", 1, undefined, "user"), view("a1", 2, "u1"), view("a2", 3, "u1"), view("u2", 4, "a2", "user")];

  it("builds a durable tree and keeps sibling order", () => {
    const tree = buildConversationBranchTree(views);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.message.message.id)).toEqual(["a1", "a2"]);
  });

  it("selects the saved head without replaying other branches", () => {
    expect(visibleConversationBranch(views, "u2").map((item) => item.message.id)).toEqual(["u1", "a2", "u2"]);
    expect(visibleConversationBranch(views, "a1").map((item) => item.message.id)).toEqual(["u1", "a1"]);
  });
  it("fails closed when a selected head is outside the loaded history page", () => {
    expect(visibleConversationBranch(views, "missing")).toEqual([]);
  });

  it("detects a branch whose ancestor is outside the loaded page", () => {
    expect(branchHasMissingAncestor([view("a2", 3, "u1")], "a2")).toBe(true);
    expect(branchHasMissingAncestor([view("u1", 1)], "u1")).toBe(false);
    expect(branchHasMissingAncestor(views, "missing")).toBe(true);
  });

  it("exposes branch heads and sibling alternatives", () => {
    expect(branchHeads(views)).toEqual(["a1", "u2"]);
    expect(branchSiblings(views, "a2").map((item) => item.message.id)).toEqual(["a1", "a2"]);
  });
  it("does not present a tool leaf as an alternative answer", () => {
    const tool = {
      message: {
        id: "tool-1",
        sequence: 5,
        kind: "tool",
        parentMessageId: "a1",
        previousMessageId: "a1",
      },
    } as never;
    expect(branchHeads([...views, tool])).toEqual(["u2"]);
  });
  it("anchors assistant actions at the owning user message", () => {
    expect(branchInputMessageId(views, "a2")).toBe("u1");
    expect(branchInputMessageId(views, "u2")).toBe("u2");
    expect(branchInputMessageId(views, "unknown")).toBeUndefined();
  });

  it("blocks branch mutations while work is active or needs reconciliation", () => {
    const work = (status: string, runIds: string[] = []) =>
      ({ status, runIds }) as never;

    expect(branchActionBlockReason([work("queued")])).toContain("Stop or finish");
    expect(branchActionBlockReason([work("awaiting-approval")])).toContain(
      "Stop or finish",
    );
    expect(branchActionBlockReason([work("blocked")])).toContain("Review and reconcile");
    expect(branchActionBlockReason([work("awaiting-user", ["run-1"])] )).toContain(
      "Review and reconcile",
    );
    expect(branchActionBlockReason([work("completed")])).toBeUndefined();
  });
});
