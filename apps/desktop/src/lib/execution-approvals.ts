import type { ApprovalGrant, ApprovalRequest } from "@fable/protocol";
import {
  createApprovalGate,
  type ToolApprovalGate,
} from "@fable/connectors/native-api/tool-executor";

/** Root routes exact decisions; each worker owns and can cancel only its gate. */
export class ExecutionApprovalRouter implements ToolApprovalGate {
  private gates = new Map<string, ToolApprovalGate>();
  private grants: ApprovalGrant[] = [];
  acquire(owner: string): ToolApprovalGate {
    const existing = this.gates.get(owner);
    if (existing) return existing;
    const gate = createApprovalGate();
    gate.replaceStandingGrants(this.grants);
    this.gates.set(owner, gate);
    return gate;
  }
  release(owner: string) {
    this.gates.get(owner)?.cancelPending();
    this.gates.delete(owner);
  }
  private pending(id: string) {
    return [...this.gates.values()].find((gate) => gate.hasPending(id));
  }
  register(_approval: ApprovalRequest): boolean {
    throw new Error("Register approvals on the exact execution owner.");
  }
  waitForDecision(approval: ApprovalRequest) {
    const gate = this.pending(approval.id);
    return gate
      ? gate.waitForDecision(approval)
      : Promise.reject(
          new Error("This execution is no longer awaiting approval."),
        );
  }
  hasPending(id: string) {
    return Boolean(this.pending(id));
  }
  resolveGrant(id: string) {
    this.pending(id)?.resolveGrant(id);
  }
  resolveDeny(id: string) {
    this.pending(id)?.resolveDeny(id);
  }
  replaceStandingGrants(grants: ApprovalGrant[]) {
    // Display-only sync. Standing grants never auto-satisfy execution.
    this.grants = grants;
    for (const gate of this.gates.values()) gate.replaceStandingGrants(grants);
  }
  cancelPending() {
    for (const gate of this.gates.values()) gate.cancelPending();
  }
}
