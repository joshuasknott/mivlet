import { ShieldCheck } from "@phosphor-icons/react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalRequest
} from "@arden/protocol";
import { SectionHeading } from "./primitives";
import type {
  ApprovalModificationDraft,
  PendingApprovalConfirmation
} from "../lib/types";

/**
 * Approvals + memory context panel. Lists pending approval requests with
 * once/session/rule/modify/deny decisions, modification drafting, high-risk
 * confirmation, active grants, and the recent audit strip.
 */

const decisionLabel: Record<ApprovalDecision, string> = {
  once: "Once",
  session: "Session",
  rule: "Rule",
  modify: "Modify",
  deny: "Deny"
};

export function ApprovalPanel({
  approvals,
  audit,
  sessionGrants,
  approvalRules,
  editingApprovalId,
  modificationDraft,
  pendingConfirmation,
  confirmationText,
  onDecision,
  onStartModify,
  onUpdateModification,
  onSaveModify,
  onCancelModify,
  onUpdateConfirmation,
  onConfirmDecision,
  onCancelConfirmation
}: {
  approvals: ApprovalRequest[];
  audit: ApprovalAuditEntry[];
  sessionGrants: ApprovalGrant[];
  approvalRules: ApprovalGrant[];
  editingApprovalId: string | null;
  modificationDraft: ApprovalModificationDraft;
  pendingConfirmation: PendingApprovalConfirmation | null;
  confirmationText: string;
  onDecision: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  onStartModify: (request: ApprovalRequest) => void;
  onUpdateModification: (draft: ApprovalModificationDraft) => void;
  onSaveModify: (request: ApprovalRequest) => void;
  onCancelModify: () => void;
  onUpdateConfirmation: (value: string) => void;
  onConfirmDecision: () => void;
  onCancelConfirmation: () => void;
}) {
  return (
    <section className="context-panel" aria-label="Approvals and memory">
      <SectionHeading title="Approvals" meta={`${approvals.length} waiting`} />
      <div className="approval-list">
        {approvals.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={22} />
            <span>No approvals are waiting.</span>
          </div>
        ) : (
          approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <div>
                <span className="label-row">
                  <ShieldCheck size={18} />
                  {approval.mode} - {approval.riskLevel} risk
                </span>
                <h3>{approval.action}</h3>
                <p>{approval.consequence}</p>
              </div>
              <dl className="approval-details">
                <div>
                  <dt>Service</dt>
                  <dd>{approval.service}</dd>
                </div>
                <div>
                  <dt>Data</dt>
                  <dd>{approval.dataUsed.join(", ")}</dd>
                </div>
              </dl>
              {editingApprovalId === approval.id ? (
                <div className="approval-edit">
                  <span>Permission mode</span>
                  <div className="permission-segments" aria-label={`Permission mode for ${approval.action}`}>
                    {(["read-only", "trusted-scope", "full-access"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={modificationDraft.mode === mode}
                        onClick={() => onUpdateModification({ ...modificationDraft, mode })}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <label>
                    <span>Allowed data</span>
                    <textarea
                      aria-label={`Allowed data for ${approval.action}`}
                      value={modificationDraft.dataUsed}
                      onChange={(event) =>
                        onUpdateModification({ ...modificationDraft, dataUsed: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Consequence</span>
                    <textarea
                      aria-label={`Consequence for ${approval.action}`}
                      value={modificationDraft.consequence}
                      onChange={(event) =>
                        onUpdateModification({ ...modificationDraft, consequence: event.target.value })
                      }
                    />
                  </label>
                  <div className="approval-actions">
                    <button type="button" onClick={() => onSaveModify(approval)}>
                      Save changes
                    </button>
                    <button type="button" onClick={onCancelModify}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : pendingConfirmation?.request.id === approval.id ? (
                <div className="approval-confirmation">
                  <strong>Confirm high-risk action</strong>
                  <p>
                    Type <code>{approval.confirmationPhrase}</code> to continue with{" "}
                    {decisionLabel[pendingConfirmation.decision].toLowerCase()} approval.
                  </p>
                  <input
                    aria-label={`Confirmation for ${approval.action}`}
                    value={confirmationText}
                    onChange={(event) => onUpdateConfirmation(event.target.value)}
                    autoFocus
                  />
                  <div className="approval-actions">
                    <button type="button" onClick={onConfirmDecision}>
                      Confirm
                    </button>
                    <button type="button" onClick={onCancelConfirmation}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="approval-actions">
                  {approval.decisions.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      onClick={() =>
                        decision === "modify" ? onStartModify(approval) : onDecision(approval, decision)
                      }
                    >
                      {decisionLabel[decision]}
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
      </div>
      {sessionGrants.length > 0 || approvalRules.length > 0 ? (
        <div className="approval-grants" aria-label="Active approvals grants">
          {sessionGrants.map((grant) => (
            <span key={grant.id}>
              Session: {grant.service} - {grant.action}
            </span>
          ))}
          {approvalRules.map((grant) => (
            <span key={grant.id}>
              Rule: {grant.service} - {grant.action}
            </span>
          ))}
        </div>
      ) : null}
      {audit.length > 0 ? (
        <div className="audit-strip" aria-label="Approval audit history">
          {audit.slice(0, 3).map((entry) => (
            <span key={entry.id}>
              {entry.decision}: {entry.note}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
