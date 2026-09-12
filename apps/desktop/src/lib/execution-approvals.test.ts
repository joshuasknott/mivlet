import { describe, expect, it } from "vitest";
import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import { ExecutionApprovalRouter } from "./execution-approvals";

describe("execution approval ownership", () => {
  it("resolves only the exact request and stopping one owner denies only its pending decisions", async () => {
    const router = new ExecutionApprovalRouter();
    const a = router.acquire("conversation-a:task-a:1");
    const b = router.acquire("conversation-b:task-b:1");
    const first = {
      ...buildToolApproval(
        "Codex",
        "write-file",
        '{"path":"a.txt","content":"fixture"}',
      ),
      id: "a",
    };
    const second = { ...first, id: "b" };
    expect(a.register(first)).toBe(true);
    expect(b.register(second)).toBe(true);
    const firstDecision = a.waitForDecision(first);
    const secondDecision = b.waitForDecision(second);
    router.resolveGrant("unknown");
    expect(router.hasPending("a")).toBe(true);
    expect(router.hasPending("b")).toBe(true);
    router.release("conversation-a:task-a:1");
    await expect(firstDecision).rejects.toThrow(
      "cancelled before it was granted",
    );
    expect(router.hasPending("b")).toBe(true);
    router.resolveGrant("b");
    await expect(secondDecision).resolves.toBe("granted");
    expect(router.hasPending("b")).toBe(false);
    expect(router.acquire("conversation-b:task-b:1")).toBe(b);
    router.release("conversation-b:task-b:1");
    expect(router.acquire("conversation-b:task-b:2").register(second)).toBe(
      true,
    );
    router.cancelPending();
  });
});
