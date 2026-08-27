import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { FileArrowDown } from "@phosphor-icons/react/dist/csr/FileArrowDown";
import { File } from "@phosphor-icons/react/dist/csr/File";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import type { LocalComputerFilesSnapshot } from "@fable/protocol";
import type { RuntimeMissionProgress } from "../../runtime";

export function LiveWorkRail({
  agentName,
  running,
  status,
  transcript,
  runId,
  approvalCount,
  computerUseActive,
  localComputer,
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
  localComputer: {
    available: boolean;
    status?: "unprovisioned" | "provisioning" | "ready" | "degraded";
    browserAvailable: boolean;
    browserActive: boolean;
    browserProduct?: string;
    filesAvailable: boolean;
    files: LocalComputerFilesSnapshot | null;
    filesLoading: boolean;
    filesError: string | null;
    controller: "agent" | "human";
    loading: boolean;
    provisioning: boolean;
    busy: boolean;
    recoveryNeeded: boolean;
    error: string | null;
    browserUrl?: string;
    browserTitle?: string;
    generation: number;
    viewport?: { width: number; height: number };
    onProvision: () => Promise<unknown>;
    onOpenBrowser: (url: string) => Promise<unknown>;
    onRefreshBrowser: () => Promise<unknown>;
    onRefreshFiles: () => Promise<unknown>;
    onTakeControl: () => Promise<unknown>;
    onReturnControl: () => Promise<unknown>;
    onClick: (x: number, y: number) => Promise<unknown>;
    onScroll: (x: number, y: number, deltaY: number) => Promise<unknown>;
    onKey: (key: string) => Promise<unknown>;
  };
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
  const [localBrowserUrl, setLocalBrowserUrl] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const localScreenRef = useRef<HTMLDivElement>(null);
  const localScreenImageRef = useRef<HTMLImageElement>(null);
  const keyQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const needsAttention = approvalCount > 0 || status === "awaiting-approval";
  const activeHostedSchedules = hostedComputer.schedules.filter((schedule) => schedule.lifecycle === "active");
  const nextHostedSchedule = activeHostedSchedules.find((schedule) => schedule.nextRunAt);
  const activeAgentRoutines = (hostedComputer.agentRoutines ?? []).filter((routine) => routine.lifecycle === "active");
  const nextAgentRoutine = activeAgentRoutines.find((routine) => routine.nextRunAt);
  const submitBrowser = (event: FormEvent) => {
    event.preventDefault();
    void hostedComputer.onOpenBrowser(browserUrl).then(() => setScreenOpen(true)).catch(() => undefined);
  };
  const submitLocalBrowser = (event: FormEvent) => {
    event.preventDefault();
    void (async () => {
      if (localComputer.controller !== "human") await localComputer.onTakeControl();
      await localComputer.onOpenBrowser(localBrowserUrl);
      setScreenOpen(true);
    })().catch(() => undefined);
  };
  const toggleLocalFiles = () => {
    const next = !filesOpen;
    setFilesOpen(next);
    if (next) void localComputer.onRefreshFiles().catch(() => undefined);
  };
  const localPoint = (event: MouseEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>) => {
    const image = localScreenImageRef.current;
    const viewport = localComputer.viewport;
    if (!viewport || !image) return null;
    const rect = image.getBoundingClientRect();
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (rect.width <= 0 || rect.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null;
    const renderedScale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedWidth = sourceWidth * renderedScale;
    const renderedHeight = sourceHeight * renderedScale;
    const renderedLeft = rect.left + (rect.width - renderedWidth) / 2;
    const renderedTop = rect.top + (rect.height - renderedHeight) / 2;
    const renderedX = event.clientX - renderedLeft;
    const renderedY = event.clientY - renderedTop;
    if (renderedX < 0 || renderedY < 0 || renderedX > renderedWidth || renderedY > renderedHeight) return null;
    return {
      x: (renderedX / renderedScale / sourceWidth) * viewport.width,
      y: (renderedY / renderedScale / sourceHeight) * viewport.height
    };
  };
  const handleLocalScreenClick = (event: MouseEvent<HTMLDivElement>) => {
    if (localComputer.controller !== "human") return;
    const point = localPoint(event);
    if (!point) return;
    localScreenRef.current?.focus();
    void localComputer.onClick(point.x, point.y).catch(() => undefined);
  };
  const handleLocalScreenWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (localComputer.controller !== "human") return;
    const point = localPoint(event);
    if (!point) return;
    event.preventDefault();
    void localComputer.onScroll(point.x, point.y, event.deltaY).catch(() => undefined);
  };
  const handleLocalScreenKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (localComputer.controller !== "human" || event.ctrlKey || event.metaKey || event.altKey) return;
    const allowedNamedKey = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key);
    if (event.key.length !== 1 && !allowedNamedKey) return;
    event.preventDefault();
    const key = event.key;
    keyQueueRef.current = keyQueueRef.current
      .catch(() => undefined)
      .then(() => localComputer.onKey(key));
  };
  return (
    <aside className="live-rail" aria-label="Work">
      <header className="live-rail__header"><div><strong>Work</strong><span>{agentName}</span></div><button type="button" onClick={onClose} aria-label="Close work"><X size={17} /></button></header>

      <section className={`hosted-computer-card local-computer-card${localComputer.recoveryNeeded || localComputer.status === "degraded" ? " is-attention" : localComputer.status === "ready" ? " is-ready" : ""}`} aria-label="Computer on this PC">
        <span className="hosted-computer-card__icon"><Browser size={18} weight={localComputer.status === "ready" ? "fill" : "regular"} /></span>
        <span className="hosted-computer-card__copy">
          <strong>Computer on this PC</strong>
          <small>{localComputer.recoveryNeeded
            ? localComputer.error ?? "The browser session needs to restart."
            : localComputer.status === "ready"
              ? localComputer.browserActive
                ? `${localComputer.browserProduct ?? "Private browser"} · separate profile and files`
                : "Private files are ready. Start this teammate's browser when needed."
            : localComputer.provisioning || localComputer.status === "provisioning"
              ? "Creating this teammate's private browser and files…"
              : localComputer.browserAvailable
                ? "Free, local, and separate for this teammate"
                : "Install Edge, Chrome, or Chromium to enable it"}</small>
        </span>
        {localComputer.available && (localComputer.recoveryNeeded || localComputer.status !== "ready" || !localComputer.browserActive) ? (
          <button type="button" onClick={() => void localComputer.onProvision().catch(() => undefined)} disabled={localComputer.provisioning || localComputer.loading || !localComputer.browserAvailable}>
            {localComputer.recoveryNeeded || localComputer.status === "degraded" ? "Retry" : localComputer.status === "ready" ? "Start" : "Set up"}
          </button>
        ) : localComputer.status === "ready" ? <span className="hosted-computer-card__state">Local</span> : null}
        {localComputer.status === "ready" && localComputer.browserActive && !localComputer.recoveryNeeded ? (
          <form className="hosted-browser-launcher" onSubmit={submitLocalBrowser}>
            <Browser size={16} aria-hidden="true" />
            <input
              type="url"
              value={localBrowserUrl}
              onChange={(event) => setLocalBrowserUrl(event.target.value)}
              placeholder="https://example.com"
              aria-label="Page to open on this teammate's local computer"
              disabled={localComputer.busy}
              required
            />
            <button type="submit" disabled={localComputer.busy}>{localComputer.busy ? "Working…" : "Open"}</button>
          </form>
        ) : null}
        {localComputer.filesAvailable ? (
          <div className="local-computer-files">
            <div className="local-computer-files__toolbar">
              <button type="button" onClick={toggleLocalFiles} aria-expanded={filesOpen} aria-controls="local-computer-files-list">
                <FolderOpen size={15} aria-hidden="true" />
                <span>Files</span>
                <small>{localComputer.files ? `${localComputer.files.entries.length}${localComputer.files.truncated ? "+" : ""}` : "Private"}</small>
              </button>
              {filesOpen ? (
                <button type="button" onClick={() => void localComputer.onRefreshFiles().catch(() => undefined)} disabled={localComputer.filesLoading} aria-label="Refresh private files">
                  <ArrowClockwise size={14} />
                </button>
              ) : null}
            </div>
            {filesOpen ? (
              <div id="local-computer-files-list" className="local-computer-files__list" role="region" aria-label={`${agentName}'s private files`}>
                {localComputer.filesLoading && !localComputer.files ? <small>Checking private files…</small>
                  : localComputer.filesError ? <small role="alert">{localComputer.filesError}</small>
                    : localComputer.files?.entries.length ? (
                      <ul>
                        {localComputer.files.entries.map((entry) => (
                          <li key={`${entry.kind}:${entry.path}`}>
                            {entry.kind === "directory" ? <FolderOpen size={14} aria-hidden="true" /> : <File size={14} aria-hidden="true" />}
                            <span title={entry.path}>{entry.path}</span>
                            <small>{entry.kind === "directory" ? "Folder" : formatBytes(entry.sizeBytes ?? 0)}</small>
                          </li>
                        ))}
                      </ul>
                    ) : <small>No files yet. This teammate can create one after you approve a write.</small>}
                {localComputer.files?.truncated ? <small>Showing the first 200 entries.</small> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {localComputer.error && !localComputer.recoveryNeeded ? <small className="hosted-browser-launcher__error" role="alert">{localComputer.error}</small> : null}
        {localComputer.status === "ready" ? (
          <small className="local-computer-card__boundary">Browser and files are separated per teammate. App and terminal isolation need a container or VM backend and remain off.</small>
        ) : null}
      </section>

      <section className={`hosted-computer-card${hostedComputer.status === "ready" ? " is-ready" : hostedComputer.status === "degraded" || hostedComputer.error ? " is-attention" : ""}`} aria-label="Optional cloud computer">
        <span className="hosted-computer-card__icon"><Cloud size={18} weight={hostedComputer.status === "ready" ? "fill" : "regular"} /></span>
        <span className="hosted-computer-card__copy">
          <strong>Optional cloud computer</strong>
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
          <section className={`live-screen-modal__panel${localComputer.browserActive ? " live-screen-modal__panel--local" : ""}`}>
            <header>
              <span><strong>{localComputer.browserActive ? localComputer.browserTitle || `${agentName}'s local browser` : hostedComputer.browserTitle || `${agentName}'s screen`}</strong><small>{localComputer.browserActive ? localComputer.browserUrl : hostedComputer.browserUrl}</small></span>
              <span className="live-screen-modal__actions">
                <button type="button" onClick={() => void (localComputer.browserActive ? localComputer.onRefreshBrowser() : hostedComputer.onRefreshBrowser()).catch(() => undefined)} disabled={hostedComputer.browserOpening || localComputer.busy} aria-label="Refresh screen preview"><ArrowClockwise size={17} /></button>
                {localComputer.recoveryNeeded ? (
                  <button type="button" onClick={() => void localComputer.onProvision().catch(() => undefined)} disabled={localComputer.provisioning || localComputer.loading}>
                    {localComputer.provisioning ? "Restarting…" : "Restart browser"}
                  </button>
                ) : localComputer.browserActive ? (
                  localComputer.controller === "human"
                    ? <button type="button" onClick={() => void localComputer.onReturnControl().catch(() => undefined)} disabled={localComputer.busy}>{localComputer.busy ? "Working…" : "Return control"}</button>
                    : <button type="button" onClick={() => void localComputer.onTakeControl().catch(() => undefined)} disabled={localComputer.busy}>{localComputer.busy ? "Working…" : "Take control"}</button>
                ) : null}
                {!localComputer.browserActive && hostedComputer.liveViewUrl ? <a href={hostedComputer.liveViewUrl} target="_blank" rel="noreferrer" aria-label="Take over in Cloudflare Live View (opens in a new window)">Take over <ArrowSquareOut size={15} /></a> : null}
                <button type="button" onClick={() => setScreenOpen(false)} aria-label="Close screen"><X size={18} /></button>
              </span>
            </header>
            {localComputer.recoveryNeeded ? (
              <div className="local-browser-recovery" role="alert">
                <Browser size={28} aria-hidden="true" />
                <strong>The private browser needs to restart</strong>
                <small>{localComputer.error ?? "Fable lost contact with this browser session."}</small>
              </div>
            ) : localComputer.browserActive ? (
              <div
                className={`local-browser-screen${localComputer.controller === "human" ? " is-human" : ""}`}
                ref={localScreenRef}
                tabIndex={localComputer.controller === "human" ? 0 : -1}
                role="group"
                aria-label={`${agentName}'s interactive local browser`}
                onClick={handleLocalScreenClick}
                onWheel={handleLocalScreenWheel}
                onKeyDown={handleLocalScreenKey}
              >
                <img ref={localScreenImageRef} src={screenPreviewUrl} alt={`${agentName}'s local browser`} draggable={false} />
                <small>{localComputer.controller === "human" ? "Click the screen, then type. Keys are sent directly and are not saved by Fable." : `${agentName} can use approved browser actions. Take control to interact safely.`}</small>
              </div>
            ) : <img src={screenPreviewUrl} alt={`${agentName}'s live computer session`} />}
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
