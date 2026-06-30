import { ShieldCheck, ShieldWarning, XCircle } from "@phosphor-icons/react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalRequest
} from "@fable/protocol";
import { SectionHeading } from "./primitives";
import type {
  ApprovalModificationDraft,
  PendingApprovalConfirmation
} from "../lib/types";
import {
  DECISION_LABELS,
  actionSummary,
  decisionDescription,
  decisionLabel,
  grantSummary,
  highRiskExplanation,
  isHighRisk,
  modifiedSummary,
  profileDescription,
  profileLabel,
  riskLabel,
  riskTone,
  serviceLabel,
  whyApprovalIsNeeded
} from "../lib/approval-copy";

/**
 * Approvals + memory context panel. Lists pending approval requests with
 * once/session/rule/modify/deny decisions, modification drafting with a preview,
 * high-risk typed confirmation, active session grants, saved rules, and the
 * recent audit strip.
 *
 * SECURITY: copy here never implies a saved rule, session grant, or typed
 * confirmation makes an action safe or bypasses execution-boundary checks. The
 * Rust side-effect boundary still rechecks each consequential action via its
 * fingerprinted one-time permit; the UI only describes what Fable asks before an
 * action runs.
 */

const DECISION_ORDER: ApprovalDecision[] = ["once", "session", "rule", "modify", "deny"];

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
  const hasGrantsOrRules = sessionGrants.length > 0 || approvalRules.length > 0;

  return (
    <section className="context-panel" aria-label="Approvals and memory">
      <SectionHeading title="Approvals" meta={`${approvals.length} waiting`} />
      <div className="approval-list">
        {approvals.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={22} />
            <span>Fable asks before taking a consequential action, so nothing is waiting.</span>
          </div>
        ) : (
          approvals.map((approval) => {
            const tone = riskTone(approval.riskLevel);
            const isEditing = editingApprovalId === approval.id;
            const isConfirming = pendingConfirmation?.request.id === approval.id;
            return (
              <article
                className={`approval-card approval-card--${tone}`}
                key={approval.id}
                data-risk={tone}
              >
                <header className="approval-card__header">
                  <span className="approval-card__summary">{actionSummary(approval)}</span>
                  <span className={`approval-risk approval-risk--${tone}`}>
                    {isHighRisk(approval.mode, approval.riskLevel) ? (
                      <ShieldWarning size={14} aria-hidden="true" />
                    ) : (
                      <ShieldCheck size={14} aria-hidden="true" />
                    )}
                    {riskLabel(approval.riskLevel)}
                  </span>
                </header>
                <p className="approval-card__why">{whyApprovalIsNeeded(approval)}</p>
                <dl className="approval-details">
                  <div>
                    <dt>Service</dt>
                    <dd>{serviceLabel(approval.service)}</dd>
                  </div>
                  <div>
                    <dt>Action</dt>
                    <dd>{approval.action}</dd>
                  </div>
                  <div>
                    <dt>Permission</dt>
                    <dd>
                      <span className="approval-profile">{profileLabel(approval.mode)}</span>
                      <small>{profileDescription(approval.mode)}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Data used</dt>
                    <dd>{approval.dataUsed.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Consequence</dt>
                    <dd>{approval.consequence}</dd>
                  </div>
                  <div>
                    <dt>Why approval is needed</dt>
                    <dd>{whyApprovalIsNeeded(approval)}</dd>
                  </div>
                </dl>

                {isEditing ? (
                  <ApprovalModifyForm
                    approval={approval}
                    draft={modificationDraft}
                    onUpdateModification={onUpdateModification}
                    onSaveModify={onSaveModify}
                    onCancelModify={onCancelModify}
                  />
                ) : isConfirming ? (
                  <ApprovalConfirmation
                    approval={approval}
                    confirmation={pendingConfirmation as PendingApprovalConfirmation}
                    confirmationText={confirmationText}
                    onUpdateConfirmation={onUpdateConfirmation}
                    onConfirmDecision={onConfirmDecision}
                    onCancelConfirmation={onCancelConfirmation}
                  />
                ) : (
                  <div className="approval-actions">
                    {DECISION_ORDER.filter((decision) =>
                      approval.decisions.includes(decision)
                    ).map((decision) => (
                      <button
                        key={decision}
                        type="button"
                        className={
                          decision === "deny"
                            ? "approval-action approval-action--deny"
                            : "approval-action"
                        }
                        aria-label={decisionLabel(decision)}
                        title={decisionDescription(decision)}
                        onClick={() =>
                          decision === "modify"
                            ? onStartModify(approval)
                            : onDecision(approval, decision)
                        }
                      >
                        {decision === "deny" ? (
                          <XCircle size={15} aria-hidden="true" />
                        ) : null}
                        {decisionLabel(decision)}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
      {hasGrantsOrRules ? (
        <div className="approval-grants" aria-label="Active approval grants and rules">
          {sessionGrants.map((grant) => (
            <span key={grant.id} className="approval-grant">
              {grantSummary(grant)}
            </span>
          ))}
          {approvalRules.map((grant) => (
            <span key={grant.id} className="approval-grant approval-grant--rule">
              {grantSummary(grant)}
            </span>
          ))}
        </div>
      ) : null}
      {audit.length > 0 ? (
        <div className="audit-strip" aria-label="Approval audit history">
          {audit.slice(0, 3).map((entry) => (
            <span key={entry.id}>
              {decisionLabel(entry.decision)}: {entry.note}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ApprovalModifyForm({
  approval,
  draft,
  onUpdateModification,
  onSaveModify,
  onCancelModify
}: {
  approval: ApprovalRequest;
  draft: ApprovalModificationDraft;
  onUpdateModification: (draft: ApprovalModificationDraft) => void;
  onSaveModify: (approval: ApprovalRequest) => void;
  onCancelModify: () => void;
}) {
  return (
    <div className="approval-edit">
      <span className="approval-edit__label">Narrow what Fable can do</span>
      {/* Live preview of the modified scope the user will save. */}
      <p className="approval-modify-preview" aria-label={`Modified summary for ${approval.action}`}>
        {modifiedSummary({
          mode: draft.mode,
          dataUsed: draft.dataUsed,
          consequence: draft.consequence
        })}
      </p>
      <label>
        <span>Permission mode</span>
        <div
          className="permission-segments"
          aria-label={`Permission mode for ${approval.action}`}
          role="group"
        >
          {(["read-only", "trusted-scope", "full-access"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={draft.mode === mode}
              onClick={() => onUpdateModification({ ...draft, mode })}
            >
              {profileLabel(mode)}
            </button>
          ))}
        </div>
      </label>
      <label>
        <span>Allowed data</span>
        <textarea
          aria-label={`Allowed data for ${approval.action}`}
          value={draft.dataUsed}
          onChange={(event) =>
            onUpdateModification({ ...draft, dataUsed: event.target.value })
          }
        />
      </label>
      <label>
        <span>Consequence</span>
        <textarea
          aria-label={`Consequence for ${approval.action}`}
          value={draft.consequence}
          onChange={(event) =>
            onUpdateModification({ ...draft, consequence: event.target.value })
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
  );
}

function ApprovalConfirmation({
  approval,
  confirmation,
  confirmationText,
  onUpdateConfirmation,
  onConfirmDecision,
  onCancelConfirmation
}: {
  approval: ApprovalRequest;
  confirmation: PendingApprovalConfirmation;
  confirmationText: string;
  onUpdateConfirmation: (value: string) => void;
  onConfirmDecision: () => void;
  onCancelConfirmation: () => void;
}) {
  const explanation = highRiskExplanation(approval, confirmation.decision);
  const matches =
    confirmationText.trim().length > 0 &&
    confirmationText.trim() === explanation.requiredPhrase;
  return (
    <div className="approval-confirmation" aria-label={`Confirmation for ${approval.action}`}>
      <strong>Confirm this high-risk action</strong>
      <p className="approval-confirmation__note">{explanation.note}</p>
      <p>
        Type <code>{explanation.requiredPhrase}</code> to continue. {explanation.whatItUnlocks}
      </p>
      <input
        aria-label={`Confirmation phrase for ${approval.action}`}
        value={confirmationText}
        onChange={(event) => onUpdateConfirmation(event.target.value)}
        autoFocus
      />
      <div className="approval-actions">
        <button type="button" onClick={onConfirmDecision} disabled={!matches}>
          Confirm
        </button>
        <button type="button" onClick={onCancelConfirmation}>
          Cancel
        </button>
      </div>
    </div>
  );
}
