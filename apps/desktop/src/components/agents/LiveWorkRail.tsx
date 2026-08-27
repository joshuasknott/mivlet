import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { FileArrowDown } from "@phosphor-icons/react/dist/csr/FileArrowDown";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useState, type FormEvent } from "react";
import type { RuntimeMissionProgress } from "../../runtime";

export function LiveWorkRail({
  agentName,
  running,
  status,
  transcript,
  runId,
  approvalCount,
  computerUseActive,
  hostedComputer,
  missionProgress,
  screenPreviewUrl,
  onReviewApprovals,
  onClose
}: {
  agentName: string;
  running: boolean;
  status: string;
  transcript: string;
  runId: string | null;
  approvalCount: number;
  computerUseActive: boolean;
  hostedComputer: {
    available: boolean;
    status?: "provisioning" | "ready" | "degraded" | "destroyed";
    runtimeActive: boolean;
    keepAlive: boolean;
    loading: boolean;
    provisioning: boolean;
    error: string | null;
    onProvision: () => void;
    browserOpening: boolean;
    browserPhase: "idle" | "preparing" | "awaiting-approval" | "opening" | "refreshing";
    browserError: string | null;
    browserUrl?: string;
    browserTitle?: string;
    liveViewUrl?: string;
    browserDownload?: { fileName: string; workspacePath: string; bytesWritten: number };
    schedules: Array<{
      scheduleId: string;
      lifecycle: "active" | "paused" | "cancelled" | "stale";
      nextRunAt?: string;
    }>;
    schedulesLoading: boolean;
    schedulesError: string | null;
    agentRoutines?: Array<{
      routineId: string;
      lifecycle: "active" | "paused" | "cancelled" | "stale";
      nextRunAt?: string;
      title: string;
    }>;
    onOpenBrowser: (url: string) => Promise<unknown>;
    onRefreshBrowser: () => Promise<unknown>;
  };
  missionProgress?: RuntimeMissionProgress;
  screenPreviewUrl?: string;
  onReviewApprovals?: () => void;
  onClose: () => void;
}) {
  const [screenOpen, setScreenOpen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const needsAttention = approvalCount > 0 || status === "awaiting-approval";
  const activeHostedSchedules = hostedComputer.schedules.filter((schedule) => schedule.lifecycle === "active");
  const nextHostedSchedule = activeHostedSchedules.find((schedule) => schedule.nextRunAt);
  const activeAgentRoutines = (hostedComputer.agentRoutines ?? []).filter((routine) => routine.lifecycle === "active");
  const nextAgentRoutine = activeAgentRoutines.find((routine) => routine.nextRunAt);
  const submitBrowser = (event: FormEvent) => {
    event.preventDefault();
    void hostedComputer.onOpenBrowser(browserUrl).then(() => setScreenOpen(true)).catch(() => undefined);
  };
  return (
    <aside className="live-rail" aria-label="Work">
      <header className="live-rail__header"><div><strong>Work</strong><span>{agentName}</span></div><button type="button" onClick={onClose} aria-label="Close work"><X size={17} /></button></header>

      <section className={`hosted-computer-card${hostedComputer.status === "ready" ? " is-ready" : hostedComputer.status === "degraded" || hostedComputer.error ? " is-attention" : ""}`} aria-label="Cloud computer">
        <span className="hosted-computer-card__icon"><Cloud size={18} weight={hostedComputer.status === "ready" ? "fill" : "regular"} /></span>
        <span className="hosted-computer-card__copy">
          <strong>Cloud computer</strong>
          <small>{hostedComputer.status === "ready" && hostedComputer.keepAlive
            ? "Always on and ready"
            : hostedComputer.provisioning || hostedComputer.status === "provisioning"
              ? "Starting an isolated computer…"
              : hostedComputer.error
                ? hostedComputer.error
                : hostedComputer.available
                  ? "Not set up for this teammate"
                  : "Available with a signed-in hosted workspace"}</small>
        </span>
        {hostedComputer.available && hostedComputer.status !== "ready" ? (
          <button type="button" onClick={hostedComputer.onProvision} disabled={hostedComputer.provisioning || hostedComputer.loading}>
            {hostedComputer.status === "degraded" || hostedComputer.error ? "Retry" : "Set up"}
          </button>
        ) : hostedComputer.status === "ready" ? <span className="hosted-computer-card__state">On</span> : null}
        {hostedComputer.status === "ready" ? (
          <form className="hosted-browser-launcher" onSubmit={submitBrowser}>
            <Browser size={16} aria-hidden="true" />
            <input
              type="url"
              value={browserUrl}
              onChange={(event) => setBrowserUrl(event.target.value)}
              placeholder="https://example.com"
              aria-label="Page to open on the cloud computer"
              disabled={hostedComputer.browserOpening}
              required
            />
            <button type="submit" disabled={hostedComputer.browserOpening}>
              {hostedComputer.browserPhase === "awaiting-approval" ? "Approve…"
                : hostedComputer.browserPhase === "preparing" ? "Preparing…"
                  : hostedComputer.browserPhase === "opening" ? "Opening…"
                    : hostedComputer.browserPhase === "refreshing" ? "Refreshing…"
                      : "Open"}
            </button>
          </form>
        ) : null}
        {hostedComputer.browserDownload ? (
          <div className="hosted-schedule-summary" aria-label="Latest cloud browser download">
            <FileArrowDown size={15} aria-hidden="true" />
            <span>
              <strong>{hostedComputer.browserDownload.fileName}</strong>
              <small>Saved to {hostedComputer.browserDownload.workspacePath} · {formatBytes(hostedComputer.browserDownload.bytesWritten)}</small>
            </span>
          </div>
        ) : null}
        {hostedComputer.browserError ? <small className="hosted-browser-launcher__error" role="alert">{hostedComputer.browserError}</small> : null}
        {hostedComputer.status === "ready" ? (
          <div className="hosted-schedule-summary" aria-label="Hosted schedules">
            <Clock size={15} aria-hidden="true" />
            <span>
              <strong>{activeAgentRoutines.length} agent routine{activeAgentRoutines.length === 1 ? "" : "s"} · {activeHostedSchedules.length} program schedule{activeHostedSchedules.length === 1 ? "" : "s"}</strong>
              <small>{hostedComputer.schedulesLoading
                ? "Checking hosted schedules…"
                : hostedComputer.schedulesError
                  ? "Schedule status needs attention"
                  : nextAgentRoutine?.nextRunAt
                    ? `${nextAgentRoutine.title} runs ${new Date(nextAgentRoutine.nextRunAt).toLocaleString()}`
                    : nextHostedSchedule?.nextRunAt
                      ? `Next program ${new Date(nextHostedSchedule.nextRunAt).toLocaleString()}`
                      : "Give this teammate a recurring cloud outcome."}</small>
            </span>
          </div>
        ) : null}
      </section>

      {computerUseActive ? (
        <button className="live-screen" type="button" onClick={() => screenPreviewUrl && setScreenOpen(true)} disabled={!screenPreviewUrl}>
          {screenPreviewUrl ? <img src={screenPreviewUrl} alt={`${agentName}'s live screen`} /> : <span className="live-screen__empty"><Browser size={24} /><span>Computer use is active</span><small>The live screen will appear when the runtime publishes a frame.</small></span>}
          <span className="live-screen__label"><span>{agentName}&apos;s screen</span>{screenPreviewUrl ? <ArrowSquareOut size={14} /> : null}</span>
        </button>
      ) : null}

      <h3 className="live-rail__section-label">{needsAttention ? "Awaiting approval" : running ? "In progress" : "Ready"}</h3>
      <section className={`live-run-card${needsAttention ? " live-run-card--attention" : ""}`}>
        <div className="live-run-card__status">{running ? <span className="live-pulse" /> : <CheckCircle size={16} weight="fill" />}<strong>{needsAttention ? "Needs your approval" : running ? "In progress" : "Ready"}</strong></div>
        <p>{transcript.trim() || (running ? "Starting this run…" : "Send a message to begin work.")}</p>
        {runId ? <small>Run {runId.slice(0, 12)}</small> : null}
        {needsAttention && onReviewApprovals ? (
          <button type="button" className="live-run-card__review" onClick={onReviewApprovals}>
            Review {approvalCount || 1} approval{(approvalCount || 1) === 1 ? "" : "s"}
          </button>
        ) : null}
      </section>

      <section className="live-rail__timeline">
        <h3>{missionProgress ? "Team activity" : "Activity"}</h3>
        {missionProgress ? missionProgress.steps.map((step) => (
          <div key={step.stepKey}>
            <span className={step.state === "running" || step.state === "ready" ? "is-active" : ""}>
              {step.state === "completed" ? <CheckCircle size={14} weight="fill" /> : <Clock size={14} />}
            </span>
            <p><strong>{step.title}</strong><small>{step.detail}</small></p>
          </div>
        )) : <div><span className={running ? "is-active" : ""}><Clock size={14} /></span><p><strong>{running ? "Agent is working" : "No active run"}</strong><small>{needsAttention ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"} waiting` : "Progress and tool activity appear here."}</small></p></div>}
      </section>

      {screenOpen && screenPreviewUrl ? (
        <div className="live-screen-modal" role="dialog" aria-modal="true" aria-label={`${agentName}'s screen`}>
          <section className="live-screen-modal__panel">
            <header>
              <span><strong>{hostedComputer.browserTitle || `${agentName}'s screen`}</strong><small>{hostedComputer.browserUrl}</small></span>
              <span className="live-screen-modal__actions">
                <button type="button" onClick={() => void hostedComputer.onRefreshBrowser().catch(() => undefined)} disabled={hostedComputer.browserOpening} aria-label="Refresh screen preview"><ArrowClockwise size={17} /></button>
                {hostedComputer.liveViewUrl ? <a href={hostedComputer.liveViewUrl} target="_blank" rel="noreferrer" aria-label="Take over in Cloudflare Live View (opens in a new window)">Take over <ArrowSquareOut size={15} /></a> : null}
                <button type="button" onClick={() => setScreenOpen(false)} aria-label="Close screen"><X size={18} /></button>
              </span>
            </header>
            <img src={screenPreviewUrl} alt={`${agentName}'s live computer session`} />
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}
