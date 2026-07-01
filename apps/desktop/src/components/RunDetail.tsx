import { useState } from "react";
import { ArrowLeft, ArrowsClockwise, ShieldCheck, X } from "@phosphor-icons/react";
import type {
  JobAttempt,
  NotificationRecord,
  ScheduledJob,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRecord
} from "@fable/protocol";
import {
  attemptLabel,
  canCancel,
  canRetry,
  findQueueEntryForRun,
  formatRunDuration,
  formatRunWhen,
  latestAttempt,
  resolveRunStatus
} from "../lib/run-status";
import { formatForInspection } from "../lib/safe-output";
import { RunStatusBadge } from "./RunStatusBadge";

/**
 * Run-detail inspection surface.
 *
 * Shows the full lifecycle of a single workflow run: resolved status, the
 * schedule/workflow it belongs to, timing + duration, attempt history, audit
 * notifications, and each step's structured input/output. Connector and tool
 * outputs are rendered through the safe-inspection funnel so no secret ever
 * reaches the DOM. Retry/cancel controls are gated on the resolved status and
 * the owning job's state, and both require an explicit confirmation step before
 * they fire (mirrors the approval-safety convention used elsewhere in the app).
 */

export interface RunDetailProps {
  run: WorkflowRun;
  job?: ScheduledJob;
  definition?: WorkflowDefinition;
  queue: SchedulerQueueEntry[];
  notifications: NotificationRecord[];
  retrying: boolean;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
  onBack: () => void;
  /** Navigate to the owning schedule (definition -> executions link). */
  onOpenSchedule?: (jobId: string) => void;
}

export function RunDetail({
  run,
  job,
  definition,
  queue,
  notifications,
  retrying,
  onRetry,
  onCancel,
  onBack,
  onOpenSchedule
}: RunDetailProps) {
  const queueEntry = findQueueEntryForRun(run.id, queue);
  const meta = resolveRunStatus(run, queueEntry);
  const duration = formatRunDuration(run);
  const attempt = latestAttempt(queueEntry);
  const auditEvents = notifications.filter((note) => note.runId === run.id);

  const retryEligible = canRetry(meta, job);
  const cancelEligible = canCancel(meta);

  return (
    <article className="run-detail" aria-labelledby="run-detail-title">
      <button type="button" className="run-detail__back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> Back to run history
      </button>

      <header className="run-detail__header">
        <div className="run-detail__title-row">
          <h1 id="run-detail-title" className="run-detail__title">
            {definition?.name ?? job?.name ?? "Workflow run"}
          </h1>
          <RunStatusBadge meta={meta} />
        </div>
        <p className="run-detail__definition">
          {definition?.description ?? job?.description ?? "Run details"}
        </p>

        <dl className="run-detail__facts">
          <Fact label="Started">{formatRunWhen(run.startedAt)}</Fact>
          {run.finishedAt ? <Fact label="Finished">{formatRunWhen(run.finishedAt)}</Fact> : null}
          {duration ? <Fact label="Duration">{duration}</Fact> : null}
          {attempt ? <Fact label="Attempt">{attemptLabel(queueEntry)}</Fact> : null}
          <Fact label="Trigger">{run.trigger}</Fact>
          {run.definitionVersion ? (
            <Fact label="Workflow version">v{run.definitionVersion}</Fact>
          ) : null}
          {job && onOpenSchedule ? (
            <Fact label="Schedule">
              <button
                type="button"
                className="run-detail__link"
                onClick={() => onOpenSchedule(job.id)}
              >
                {job.name}
              </button>
            </Fact>
          ) : null}
        </dl>

        {(retryEligible || cancelEligible) && (
          <div className="run-detail__actions">
            {retryEligible ? (
              <RetryControl
                runId={run.id}
                pending={retrying}
                onRetry={onRetry}
              />
            ) : null}
            {cancelEligible ? (
              <CancelControl runId={run.id} pending={false} onCancel={onCancel} />
            ) : null}
          </div>
        )}
      </header>

      {run.failureReason ? (
        <section className="run-detail__error" aria-label="Run error">
          <h2 className="run-detail__section-title">Error</h2>
          <p className="run-detail__error-text">{run.failureReason}</p>
        </section>
      ) : null}

      <AttemptsSection queueEntry={queueEntry} />

      <AuditSection events={auditEvents} />

      <StepsSection steps={run.steps} definition={definition} />
    </article>
  );
}

/** Retry control with an explicit confirmation step + pending state. */
function RetryControl({
  runId,
  pending,
  onRetry
}: {
  runId: string;
  pending: boolean;
  onRetry: (runId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (pending) {
    return (
      <button type="button" className="button button--primary" disabled>
        Retrying…
      </button>
    );
  }
  if (!confirming) {
    return (
      <button
        type="button"
        className="button button--primary"
        onClick={() => setConfirming(true)}
      >
        <ArrowsClockwise size={15} aria-hidden="true" /> Retry run
      </button>
    );
  }
  return (
    <span className="run-detail__confirm">
      <span className="run-detail__confirm-text">Run this workflow again?</span>
      <button
        type="button"
        className="button button--primary"
        onClick={() => {
          setConfirming(false);
          onRetry(runId);
        }}
      >
        Confirm retry
      </button>
      <button
        type="button"
        className="button"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </button>
    </span>
  );
}

/** Cancel control with an explicit confirmation step + pending state. */
function CancelControl({
  runId,
  pending,
  onCancel
}: {
  runId: string;
  pending: boolean;
  onCancel: (runId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (pending) {
    return (
      <button type="button" className="button button--destructive" disabled>
        Cancelling…
      </button>
    );
  }
  if (!confirming) {
    return (
      <button
        type="button"
        className="button button--destructive"
        onClick={() => setConfirming(true)}
      >
        <X size={15} aria-hidden="true" /> Cancel run
      </button>
    );
  }
  return (
    <span className="run-detail__confirm">
      <span className="run-detail__confirm-text">Stop this run?</span>
      <button
        type="button"
        className="button button--destructive"
        onClick={() => {
          setConfirming(false);
          onCancel(runId);
        }}
      >
        Confirm cancel
      </button>
      <button type="button" className="button" onClick={() => setConfirming(false)}>
        Keep running
      </button>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="run-detail__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AttemptsSection({ queueEntry }: { queueEntry?: SchedulerQueueEntry }) {
  if (!queueEntry || queueEntry.attempts.length === 0) return null;
  return (
    <section className="run-detail__section" aria-label="Attempt history">
      <h2 className="run-detail__section-title">Attempts</h2>
      <ol className="run-detail__attempts">
        {queueEntry.attempts.map((entry) => (
          <AttemptRow key={`${entry.runId}-${entry.attemptNumber}`} attempt={entry} />
        ))}
      </ol>
    </section>
  );
}

function AttemptRow({ attempt }: { attempt: JobAttempt }) {
  return (
    <li className={`run-detail__attempt run-detail__attempt--${attempt.status}`}>
      <span className="run-detail__attempt-number">#{attempt.attemptNumber}</span>
      <span className="run-detail__attempt-status">{attempt.status}</span>
      {attempt.startedAt ? (
        <span className="run-detail__attempt-time">
          {formatRunWhen(attempt.startedAt)}
          {attempt.finishedAt ? ` → ${formatRunWhen(attempt.finishedAt)}` : ""}
        </span>
      ) : null}
      {attempt.error ? (
        <span className="run-detail__attempt-error">{attempt.error}</span>
      ) : null}
      {attempt.retryable ? (
        <span className="run-detail__attempt-flag">retryable</span>
      ) : null}
    </li>
  );
}

function AuditSection({ events }: { events: NotificationRecord[] }) {
  if (events.length === 0) return null;
  return (
    <section className="run-detail__section" aria-label="Audit events">
      <h2 className="run-detail__section-title">Audit events</h2>
      <ul className="run-detail__audit">
        {events.map((event) => (
          <li key={event.id} className="run-detail__audit-item">
            <span className="run-detail__audit-kind" aria-hidden="true">
              <ShieldCheck size={14} />
            </span>
            <span className="run-detail__audit-title">{event.title}</span>
            {event.body ? (
              <span className="run-detail__audit-body">{event.body}</span>
            ) : null}
            <span className="run-detail__audit-time">{formatRunWhen(event.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StepsSection({
  steps,
  definition
}: {
  steps: WorkflowStepRecord[];
  definition?: WorkflowDefinition;
}) {
  if (steps.length === 0) {
    return (
      <section className="run-detail__section" aria-label="Run steps">
        <h2 className="run-detail__section-title">Steps</h2>
        <p className="run-empty">No step records yet for this run.</p>
      </section>
    );
  }
  return (
    <section className="run-detail__section" aria-label="Run steps">
      <h2 className="run-detail__section-title">Steps</h2>
      <ol className="run-detail__steps">
        {steps.map((step, index) => (
          <StepRow key={`${step.stepId}-${index}`} step={step} definition={definition} />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  definition
}: {
  step: WorkflowStepRecord;
  definition?: WorkflowDefinition;
}) {
  const definitionStep = definition?.steps.find((candidate) => candidate.id === step.stepId);
  const label = stepLabel(step.stepId, definitionStep);
  const hasOutput = step.output !== undefined && step.output !== null && step.output !== "";
  return (
    <li className={`run-detail__step run-detail__step--${step.status}`}>
      <div className="run-detail__step-head">
        <span className="run-detail__step-name">{label}</span>
        <span className="run-detail__step-status">{step.status}</span>
      </div>
      {step.startedAt ? (
        <span className="run-detail__step-meta">
          {formatRunWhen(step.startedAt)}
          {step.finishedAt ? ` → ${formatRunWhen(step.finishedAt)}` : ""}
        </span>
      ) : null}
      {step.error ? <p className="run-detail__step-error">{step.error}</p> : null}
      {step.toolCalls && step.toolCalls.length > 0 ? (
        <ul className="run-detail__tool-calls">
          {step.toolCalls.map((call, index) => (
            <li key={`${call.tool}-${index}`} className="run-detail__tool-call">
              <details>
                <summary>
                  {call.tool}
                  {call.ok ? "" : " · failed"}
                </summary>
                <StructuredOutput label="Arguments" value={call.arguments} />
                <StructuredOutput label="Output" value={call.output} />
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      {hasOutput ? <StructuredOutput label="Output" value={step.output} /> : null}
      {step.approval ? (
        <p className="run-detail__step-approval">
          Approval: {step.approval.decision}
          {step.approval.expiresAt
            ? ` · expires ${formatRunWhen(step.approval.expiresAt)}`
            : ""}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Read-only structured output block. Always rendered through the safe-inspection
 * funnel so connector/tool payloads are redacted + bounded before display.
 */
function StructuredOutput({ label, value }: { label: string; value: unknown }) {
  const text = formatForInspection(value);
  return (
    <div className="run-detail__output">
      <span className="run-detail__output-label">{label}</span>
      <pre className="run-detail__output-text">{text}</pre>
    </div>
  );
}

function stepLabel(
  stepId: string,
  definitionStep?: WorkflowDefinition["steps"][number]
): string {
  if (definitionStep) {
    const detail =
      definitionStep.kind === "prompt" || definitionStep.kind === "agent"
        ? definitionStep.prompt.slice(0, 60)
        : definitionStep.kind === "tool"
          ? definitionStep.tool
          : definitionStep.kind === "connector-read"
            ? `${definitionStep.connectorId} · ${definitionStep.capability}`
            : definitionStep.kind === "approval"
              ? definitionStep.description
              : "";
    return detail ? `${definitionStep.kind}: ${detail}` : definitionStep.kind;
  }
  return stepId;
}
