import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalAuditEntry
} from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPanel } from "./ApprovalPanel";
import type {
  ApprovalModificationDraft,
  PendingApprovalConfirmation
} from "../lib/types";

/**
 * Rendering + behavior coverage for the smoother approvals UX. The panel is a
 * presentational component, so these tests drive it directly with stub props and
 * assert the plain labels, required card fields, high-risk confirmation copy,
 * modify preview, deny accessibility, and the grants/rules inspection surface.
 */

const baseApproval: ApprovalRequest = {
  id: "approval-1",
  service: "google-drive",
  action: "Delete file launch-plan.md",
  mode: "full-access",
  riskLevel: "high",
  dataUsed: ["file: launch-plan.md"],
  consequence: "Permanently deletes a Google Drive file.",
  requestedAt: "2026-06-30T00:00:00.000Z",
  decisions: ["once", "modify", "deny"],
  confirmationPhrase: "approve delete file launch-plan.md"
};

const lowRiskApproval: ApprovalRequest = {
  ...baseApproval,
  id: "approval-low",
  action: "Read file launch-plan.md",
  mode: "read-only",
  riskLevel: "low",
  consequence: "Reads one Google Drive file.",
  decisions: ["once", "session", "rule", "modify", "deny"],
  confirmationPhrase: undefined
};

const baseDraft: ApprovalModificationDraft = {
  mode: "read-only",
  dataUsed: "",
  consequence: ""
};

function noop(): void {
  /* default no-op */
}

interface PanelProps {
  compact?: boolean;
  approvals?: ApprovalRequest[];
  audit?: ApprovalAuditEntry[];
  sessionGrants?: ApprovalGrant[];
  approvalRules?: ApprovalGrant[];
  editingApprovalId?: string | null;
  modificationDraft?: ApprovalModificationDraft;
  pendingConfirmation?: PendingApprovalConfirmation | null;
  confirmationText?: string;
  onDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  onStartModify?: (request: ApprovalRequest) => void;
  onUpdateModification?: (draft: ApprovalModificationDraft) => void;
  onSaveModify?: (request: ApprovalRequest) => void;
  onCancelModify?: () => void;
  onUpdateConfirmation?: (value: string) => void;
  onConfirmDecision?: () => void;
  onCancelConfirmation?: () => void;
}

/** Mocked callback handlers, typed so `.mock` is always accessible. */
type HandlerKey =
  | "onDecision"
  | "onStartModify"
  | "onUpdateModification"
  | "onSaveModify"
  | "onCancelModify"
  | "onUpdateConfirmation"
  | "onConfirmDecision"
  | "onCancelConfirmation";

function renderPanel(props: PanelProps = {}) {
  const handlers: Record<HandlerKey, ReturnType<typeof vi.fn>> = {
    onDecision: vi.fn(),
    onStartModify: vi.fn(),
    onUpdateModification: vi.fn(),
    onSaveModify: vi.fn(),
    onCancelModify: vi.fn(),
    onUpdateConfirmation: vi.fn(),
    onConfirmDecision: vi.fn(),
    onCancelConfirmation: vi.fn()
  };
  const view = render(
    <ApprovalPanel
      compact={props.compact}
      approvals={props.approvals ?? [baseApproval]}
      audit={props.audit ?? []}
      sessionGrants={props.sessionGrants ?? []}
      approvalRules={props.approvalRules ?? []}
      editingApprovalId={props.editingApprovalId ?? null}
      modificationDraft={props.modificationDraft ?? baseDraft}
      pendingConfirmation={props.pendingConfirmation ?? null}
      confirmationText={props.confirmationText ?? ""}
      onDecision={handlers.onDecision}
      onStartModify={handlers.onStartModify}
      onUpdateModification={handlers.onUpdateModification}
      onSaveModify={handlers.onSaveModify}
      onCancelModify={handlers.onCancelModify}
      onUpdateConfirmation={handlers.onUpdateConfirmation}
      onConfirmDecision={handlers.onConfirmDecision}
      onCancelConfirmation={handlers.onCancelConfirmation}
    />
  );
  return { view, handlers };
}

describe("ApprovalPanel — required card fields", () => {
  it("keeps compact decisions visible and details collapsed without the sidebar heading", () => {
    const { handlers } = renderPanel({ compact: true });
    expect(screen.queryByRole("heading", { name: "Approvals" })).not.toBeInTheDocument();
    expect(screen.getByText("View action details").closest("details")).not.toHaveAttribute("open");
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(deny).toBeVisible(); fireEvent.click(deny);
    expect(handlers.onDecision).toHaveBeenCalledWith(baseApproval, "deny");
  });
  it("shows the short action summary, service, profile, risk, data, consequence, and why-needed", () => {
    renderPanel();

    const card = screen.getByText("Google Drive · Delete file launch-plan.md").closest("article");
    expect(card).not.toBeNull();
    const cardText = (card as HTMLElement).textContent ?? "";

    // Requirement 1: approval cards must show all required fields.
    expect(cardText).toContain("Google Drive"); // service
    expect(cardText).toContain("Delete file launch-plan.md"); // action summary
    expect(cardText).toContain("High risk"); // risk level
    expect(cardText).toContain("file: launch-plan.md"); // data used
    expect(cardText).toContain("Permanently deletes a Google Drive file."); // consequence
    expect(cardText).toMatch(/why/i); // why approval is needed label
  });

  it("renders the plain approval choice (not the raw mode)", () => {
    renderPanel();
    expect(screen.getByText("Work Freely")).toBeInTheDocument();
  });
});

describe("ApprovalPanel — plain decision labels", () => {
  it("renders the exact plain decision labels", () => {
    renderPanel({ approvals: [lowRiskApproval] });
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow for this session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as rule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("fires onDecision with the chosen decision when an approve/session/rule/deny button is clicked", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({ approvals: [lowRiskApproval] });

    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(handlers.onDecision).toHaveBeenCalledWith(lowRiskApproval, "once");

    await user.click(screen.getByRole("button", { name: "Save as rule" }));
    expect(handlers.onDecision).toHaveBeenCalledWith(lowRiskApproval, "rule");
  });

  it("never offers session or saved-rule shortcuts for high-risk work", () => {
    renderPanel({
      approvals: [
        {
          ...baseApproval,
          decisions: ["once", "session", "rule", "modify", "deny"]
        }
      ]
    });
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as rule" })).toBeNull();
  });
});

describe("ApprovalPanel — deny accessibility", () => {
  it("keeps Deny as a single always-available button that never needs confirmation", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel();

    const denyButton = screen.getByRole("button", { name: "Deny" });
    expect(denyButton).toBeEnabled();
    // A single click denies immediately — no confirmation step in between.
    await user.click(denyButton);
    expect(handlers.onDecision).toHaveBeenCalledWith(baseApproval, "deny");
    expect(handlers.onConfirmDecision).not.toHaveBeenCalled();
  });

  it("does not show a high-risk confirmation when Deny is the only available decision", () => {
    const denyOnly: ApprovalRequest = {
      ...baseApproval,
      decisions: ["deny"]
    };
    renderPanel({ approvals: [denyOnly] });
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.queryByText(/type the exact phrase/i)).not.toBeInTheDocument();
  });
});

describe("ApprovalPanel — high-risk confirmation", () => {
  it("explains the required phrase and what confirming unlocks", () => {
    renderPanel({
      pendingConfirmation: { request: baseApproval, decision: "session" },
      confirmationText: ""
    });

    // The exact phrase to type is shown.
    expect(
      screen.getByText("approve delete file launch-plan.md")
    ).toBeInTheDocument();
    // The copy explains it is high-risk and requires the exact typed phrase.
    expect(screen.getByText(/type the exact phrase/i)).toBeInTheDocument();
    // The copy explains what confirming unlocks and that Mivlet still runs a
    // final check before the action runs.
    expect(screen.getAllByText(/final check/i).length).toBeGreaterThan(0);
  });

  it("never implies the typed phrase makes the action safe", () => {
    renderPanel({
      pendingConfirmation: { request: baseApproval, decision: "session" },
      confirmationText: ""
    });
    const confirmation = screen.getByLabelText(/confirmation for/i);
    const region = confirmation.closest("div") as HTMLElement;
    expect((region.textContent ?? "").toLowerCase()).not.toMatch(/this is safe|guaranteed safe/);
  });
});

describe("ApprovalPanel — modify flow", () => {
  const editingDraft: ApprovalModificationDraft = {
    mode: "read-only",
    dataUsed: "file: launch-plan.md",
    consequence: "Reads a single file."
  };

  it("shows a modified summary preview before the user saves", () => {
    renderPanel({
      editingApprovalId: "approval-1",
      modificationDraft: editingDraft
    });

    // Requirement 4: the user sees the modified summary before saving.
    const card = screen.getByRole("article");
    const cardText = card.textContent ?? "";
    expect(cardText).toContain("file: launch-plan.md");
    expect(cardText).toContain("Reads a single file.");
    // The preview surfaces the narrowed permission profile label.
    expect(cardText).toMatch(/Read.?only|Confirm every action/i);
  });

  it("lets the user change the permission mode, data, and consequence", () => {
    const { handlers } = renderPanel({
      editingApprovalId: "approval-1",
      modificationDraft: editingDraft
    });

    const dataField = screen.getByLabelText(/information mivlet can use for/i) as HTMLTextAreaElement;
    // The component is controlled: each change reports the next draft to the
    // parent handler (here a stub), so assert the handler is called with the
    // narrowed data value.
    fireEvent.change(dataField, { target: { value: "file: safer.md" } });
    expect(handlers.onUpdateModification).toHaveBeenCalled();
    expect(handlers.onUpdateModification.mock.calls.at(-1)?.[0].dataUsed).toBe("file: safer.md");

    // The plain choice segments also report changes.
    fireEvent.click(screen.getByRole("button", { name: "Work Freely" }));
    expect(handlers.onUpdateModification.mock.calls.at(-1)?.[0].mode).toBe("full-access");
  });

  it("saves the modified approval with the previewed scope", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({
      editingApprovalId: "approval-1",
      modificationDraft: editingDraft
    });

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(handlers.onSaveModify).toHaveBeenCalledWith(baseApproval);
  });
});

describe("ApprovalPanel — active grants + saved rules inspection", () => {
  const sessionGrant: ApprovalGrant = {
    id: "grant-1",
    requestId: "approval-1",
    scope: "session",
    service: "google-drive",
    action: "Read file launch-plan.md",
    mode: "read-only",
    dataUsed: ["file: launch-plan.md"],
    createdAt: "2026-06-30T09:00:00.000Z"
  };
  const savedRule: ApprovalGrant = {
    ...sessionGrant,
    id: "rule-1",
    scope: "rule",
    action: "Create issue"
  };

  it("lists active session grants with service/action/mode and created time", () => {
    renderPanel({ approvals: [], sessionGrants: [sessionGrant] });
    const grantsRegion = screen.getByLabelText(/active.*grant|grants/i);
    const text = grantsRegion.textContent ?? "";
    expect(text).toContain("Google Drive");
    expect(text).toContain("Read file launch-plan.md");
    expect(text).toMatch(/read.?only|confirm every action/i);
    expect(text).toContain("2026");
  });

  it("lists saved rules distinctly from session grants", () => {
    renderPanel({ approvals: [], approvalRules: [savedRule] });
    const grantsRegion = screen.getByLabelText(/active.*grant|grants/i);
    expect(grantsRegion.textContent ?? "").toMatch(/saved rule|rule/i);
    expect(grantsRegion.textContent ?? "").toContain("Create issue");
  });
});

describe("ApprovalPanel — empty state", () => {
  it("explains that Mivlet asks before consequential actions", () => {
    renderPanel({ approvals: [] });
    const empty = screen.getByText(/asks before/i);
    expect(empty).toBeInTheDocument();
  });
});
