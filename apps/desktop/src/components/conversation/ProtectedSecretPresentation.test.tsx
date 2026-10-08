import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { buildToolApproval } from "@mivlet/connectors/native-api/approvals";
import { describe, expect, it, vi } from "vitest";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import { actionSummary } from "../../lib/approval-copy";
import { ConversationFeed } from "./ConversationFeed";
import { ApprovalPanel } from "../ApprovalPanel";

const agent: MivletAgentProfile = { id: "release", name: "Release agent", icon: "agent", iconColor: "#24bb77", instructions: "", modelId: "", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };
const initial: NativeAgentState = { transcript: "", usage: null, running: true, lastError: null, status: "streaming", recoverableAttempts: [], contextReceipts: {}, providerRoutes: {}, usageReceipts: {}, currentAttemptId: "run", noTransport: false, progressThreadId: "thread", progressAgentId: agent.id, responseParts: [{ id: "call", kind: "tool", tool: "request-secret", state: "running", content: "" }] };
const props = { messages: [], agent, threadId: "thread", profileName: "You", connectors: [], optimisticPrompt: "", workspaceId: "default" };

describe("protected request presentation", () => {
  it("names the native handoff, then finishes a decline without claiming a secret was saved", () => {
    const view = render(<ConversationFeed {...props} state={initial} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for protected secret entry");
    expect(view.container.querySelector("input,textarea")).toBeNull();
    view.rerender(<ConversationFeed {...props} state={{ ...initial, running: false, status: "completed", responseParts: [{ id: "call", kind: "tool", tool: "request-secret", state: "succeeded", content: '{"status":"declined","secretRef":"synthetic-opaque-reference"}' }] }} />);
    fireEvent.click(screen.getByText("Worked"));
    expect(screen.getByText("Protected secret request finished")).toBeVisible();
    expect(view.container.textContent).not.toMatch(/secret saved|synthetic-opaque-reference/i);
  });

  it.each([
    "This protected request expired. Request a new secret.",
    "The requesting agent or account stopped. Request a new secret in a new turn.",
    "Computer control is busy. Finish or stop the current action before starting another request.",
    "Native protected credential storage is unavailable. No secret was returned."
  ])("retains actionable failure detail without offering reference replay: %s", (message) => {
    const view = render(<ConversationFeed {...props} state={{ ...initial, running: false, responseParts: [{ id: "call", kind: "tool", tool: "request-secret", state: "failed", content: message }] }} />);
    expect(screen.getByText(/1 failed attempt/)).toBeVisible();
    fireEvent.click(screen.getByText("Worked"));
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry|replay/i })).toBeNull();
    expect(view.container.querySelector("input,textarea")).toBeNull();
  });

  it("hides another identity's pending native handoff", () => {
    render(<ConversationFeed {...props} state={{ ...initial, progressAgentId: "other-agent" }} />);
    expect(screen.queryByText("Waiting for protected secret entry")).toBeNull();
  });

  it("presents a keyboard-operable decision while retaining the exact approval payload", async () => {
    const approval = buildToolApproval("codex", "request-secret", JSON.stringify({ label: "Release signing key", reason: "Verify release events", consumer: "webhook-signing-key", purpose: "verify-webhook-signature", targetId: "releases" }));
    const before = JSON.stringify(approval);
    const decide = vi.fn();
    const noop = () => {};
    const view = render(<ApprovalPanel compact approvals={[approval]} audit={[]} sessionGrants={[]} approvalRules={[]} editingApprovalId={null} modificationDraft={{ mode: "read-only", dataUsed: "", consequence: "" }} pendingConfirmation={null} confirmationText="" onDecision={decide} onStartModify={noop} onUpdateModification={noop} onSaveModify={noop} onCancelModify={noop} onUpdateConfirmation={noop} onConfirmDecision={noop} onCancelConfirmation={noop} />);
    expect(screen.getByText("Request a webhook signing secret")).toBeVisible();
    expect(screen.getByText("Protected secret")).toBeVisible();
    expect(screen.getByText("One request only")).toBeVisible();
    expect(view.container.querySelector("input,textarea")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByText("View action details"));
    expect(screen.getByText(approval.action)).toBeVisible();
    // JSDOM does not model native summary tab order; the browser fixture does.
    screen.getByRole("button", { name: "Approve" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(decide).toHaveBeenCalledExactlyOnceWith(approval, "deny");
    expect(JSON.stringify(approval)).toBe(before);
    expect(actionSummary({ ...approval, action: "request-secret-unregistered" })).toBe("Codex · request-secret-unregistered");
    expect(actionSummary({ ...approval, action: "constructor" })).toBe("Codex · constructor");
  });
});
