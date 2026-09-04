import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { FileArrowDown } from "@phosphor-icons/react/dist/csr/FileArrowDown";
import { File } from "@phosphor-icons/react/dist/csr/File";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import restingWallpaper from "../../assets/computer-wallpaper.png";
import { useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type WheelEvent } from "react";
import type { LocalComputerApplication, LocalComputerFilePreview, LocalComputerFilesSnapshot } from "@fable/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export function LiveWorkRail({
  agentName,
  approvalPanel,
  localComputer,
  hostedComputer,
  screenPreviewUrl,
  conversations = [],
  activeConversationId,
  conversationBusy = false,
  onNewConversation,
  onSelectConversation,
  onClose
}: {
  agentName: string;
  approvalPanel?: ReactNode;
  localComputer: {
    available: boolean;
    status?: "unprovisioned" | "provisioning" | "ready" | "degraded";
    browserAvailable: boolean;
    browserActive: boolean;
    browserProduct?: string;
    canGoBack: boolean;
    canGoForward: boolean;
    filesAvailable: boolean;
    files: LocalComputerFilesSnapshot | null;
    filesLoading: boolean;
    filesError: string | null;
    filePreview: LocalComputerFilePreview | null;
    filePreviewLoading: boolean;
    filePreviewError: string | null;
    controller: "agent" | "human";
    loading: boolean;
    provisioning: boolean;
    busy: boolean;
    recoveryNeeded: boolean;
    error: string | null;
    browserUrl?: string;
    browserTitle?: string;
    generation: number;
    leaseExpiresAt?: string;
    viewport?: { width: number; height: number };
    onProvision: () => Promise<unknown>;
    onOpenBrowser: (url: string) => Promise<unknown>;
    onRefreshBrowser: () => Promise<unknown>;
    onGoBack: () => Promise<unknown>;
    onGoForward: () => Promise<unknown>;
    onRefreshFiles: () => Promise<unknown>;
    onPreviewFile: (path: string) => Promise<unknown>;
    onCloseFilePreview: () => void;
    onTakeControl: () => Promise<unknown>;
    onReturnControl: () => Promise<unknown>;
    onClick: (x: number, y: number) => Promise<unknown>;
    onScroll: (x: number, y: number, deltaY: number) => Promise<unknown>;
    onKey: (key: string) => Promise<unknown>;
    onLaunchApplication: (application: LocalComputerApplication) => Promise<unknown>;
  };
  hostedComputer: {
    available: boolean;
    status?: "provisioning" | "ready" | "degraded" | "destroyed";
    runtimeActive: boolean;
    keepAlive: boolean;
    loading: boolean;
    provisioning: boolean;
    error: string | null;
    onProvision: () => Promise<unknown>;
    browserOpening: boolean;
    browserPhase: "idle" | "preparing" | "awaiting-approval" | "opening" | "refreshing";
    browserError: string | null;
    browserUrl?: string;
    browserTitle?: string;
    liveViewUrl?: string;
    browserDownload?: { fileName: string; workspacePath: string; bytesWritten: number };
    onOpenBrowser: (url: string) => Promise<unknown>;
    onRefreshBrowser: () => Promise<unknown>;
  };
  screenPreviewUrl?: string;
  conversations?: { id: string; title: string; time: string }[];
  activeConversationId?: string;
  conversationBusy?: boolean;
  onNewConversation?: () => void;
  onSelectConversation?: (id: string) => void;
  onClose: () => void;
}) {
  const [screenOpen, setScreenOpen] = useState(false);
  const [computerDetailsOpen, setComputerDetailsOpen] = useState(false);
  const screenDialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ active: screenOpen && Boolean(screenPreviewUrl), containerRef: screenDialogRef, onClose: () => setScreenOpen(false) });
  const [browserUrl, setBrowserUrl] = useState("");
  const [localBrowserUrl, setLocalBrowserUrl] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const localScreenRef = useRef<HTMLDivElement>(null);
  const localScreenImageRef = useRef<HTMLImageElement>(null);
  const filePreviewDialogRef = useRef<HTMLDivElement>(null);
  const filePreviewCloseRef = useRef<HTMLButtonElement>(null);
  const keyQueueRef = useRef<Promise<unknown>>(Promise.resolve());
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
  const openLocalApplication = (application: LocalComputerApplication) => {
    void (async () => {
      if (localComputer.controller !== "human") await localComputer.onTakeControl();
      await localComputer.onLaunchApplication(application);
      setScreenOpen(true);
    })().catch(() => undefined);
  };
  const toggleLocalFiles = () => {
    const next = !filesOpen;
    setFilesOpen(next);
    if (next) void localComputer.onRefreshFiles().catch(() => undefined);
  };
  const openLocalFile = (path: string) => {
    setScreenOpen(false);
    void localComputer.onPreviewFile(path).catch(() => undefined);
  };
  useModalFocusTrap({
    active: Boolean(localComputer.filePreview),
    containerRef: filePreviewDialogRef,
    initialFocusRef: filePreviewCloseRef,
    onClose: localComputer.onCloseFilePreview
  });
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
      <header className="live-rail__header"><button type="button" onClick={onClose} aria-label="Close work"><X size={17} /></button></header>
      <section className="computer-overview" aria-label={`${agentName}'s computer`}>
        <button className="computer-overview__preview" type="button" onClick={() => {
          if (screenPreviewUrl) setScreenOpen(true);
          else setComputerDetailsOpen(true);
        }} aria-label={screenPreviewUrl ? `Open ${agentName}'s screen` : "Open computer setup"}>
          <img src={screenPreviewUrl ?? restingWallpaper} alt={screenPreviewUrl ? `${agentName}'s latest computer screen` : "Resting computer wallpaper preview"} />
          {!screenPreviewUrl ? <span>Computer preview</span> : null}
        </button>
        <p>{localComputer.recoveryNeeded ? "Computer needs attention" : localComputer.provisioning ? "Preparing computer…" : localComputer.browserActive || hostedComputer.runtimeActive ? (localComputer.controller === "human" ? "You have control" : "Computer is running") : "Computer is resting"}</p>
        <button className="computer-overview__action" type="button" onClick={() => {
          if (screenPreviewUrl) setScreenOpen(true);
          else setComputerDetailsOpen(true);
        }}>{screenPreviewUrl ? "Open computer" : "Set up computer"}</button>
      </section>
      {approvalPanel}
      <details className="computer-details" open={computerDetailsOpen} onToggle={(event) => setComputerDetailsOpen(event.currentTarget.open)}>
      <summary>Computer options</summary>
      <section className={`hosted-computer-card local-computer-card${localComputer.recoveryNeeded || localComputer.status === "degraded" ? " is-attention" : localComputer.status === "ready" ? " is-ready" : ""}`} aria-label="Computer on this PC">
        <span className="hosted-computer-card__icon"><Browser size={18} weight={localComputer.status === "ready" ? "fill" : "regular"} /></span>
        <span className="hosted-computer-card__copy">
          <strong>Computer on this PC</strong>
          <small>{localComputer.recoveryNeeded
            ? localComputer.error ?? "The private Linux computer needs to restart."
            : localComputer.status === "ready"
              ? localComputer.browserActive
                ? `${localComputer.browserProduct ?? "Private Linux desktop"} · persistent home and workspace`
                : "The private Linux desktop is ready. Start it when needed."
            : localComputer.provisioning || localComputer.status === "provisioning"
              ? "Building this teammate's private Linux desktop…"
              : localComputer.browserAvailable
                ? "Docker/WSL isolation is ready for setup"
                : "Start Docker Desktop with its WSL 2 engine"}</small>
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
        {localComputer.status === "ready" && localComputer.browserActive && !localComputer.recoveryNeeded ? (
          <div className="local-computer-apps" aria-label="Linux desktop applications">
            <button type="button" onClick={() => openLocalApplication("browser")} disabled={localComputer.busy}>Browser</button>
            <button type="button" onClick={() => openLocalApplication("files")} disabled={localComputer.busy}>Files app</button>
            <button type="button" onClick={() => openLocalApplication("terminal")} disabled={localComputer.busy}>Terminal</button>
          </div>
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
                            {entry.kind === "directory" ? (
                              <span className="local-computer-files__entry">
                                <FolderOpen size={14} aria-hidden="true" />
                                <span title={entry.path}>{entry.path}</span>
                                <small>Folder</small>
                              </span>
                            ) : (
                              <button type="button" className="local-computer-files__entry" onClick={() => openLocalFile(entry.path)} disabled={localComputer.filePreviewLoading} aria-label={`Preview ${entry.path}`}>
                                <File size={14} aria-hidden="true" />
                                <span title={entry.path}>{entry.path}</span>
                                <small>{formatBytes(entry.sizeBytes ?? 0)}</small>
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : <small>No files yet. This teammate can create one after you approve a write.</small>}
                {localComputer.files?.truncated ? <small>Showing the first 200 entries.</small> : null}
                {localComputer.filePreviewError ? <small role="alert">{localComputer.filePreviewError}</small> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {localComputer.error && !localComputer.recoveryNeeded ? <small className="hosted-browser-launcher__error" role="alert">{localComputer.error}</small> : null}
        {localComputer.status === "ready" ? (
          <small className="local-computer-card__boundary">A separate Linux container holds this teammate&apos;s persistent desktop, browser profile, terminal, and files. Human control uses a renewable five-minute lease.</small>
        ) : null}
      </section>

      {hostedComputer.available ? <section className={`hosted-computer-card${hostedComputer.status === "ready" ? " is-ready" : hostedComputer.status === "degraded" || hostedComputer.error ? " is-attention" : ""}`} aria-label="Optional hosted computer">
        <span className="hosted-computer-card__icon"><Cloud size={18} weight={hostedComputer.status === "ready" ? "fill" : "regular"} /></span>
        <span className="hosted-computer-card__copy">
          <strong>Optional hosted computer</strong>
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
          <div className="hosted-download-summary" aria-label="Latest cloud browser download">
            <FileArrowDown size={15} aria-hidden="true" />
            <span>
              <strong>{hostedComputer.browserDownload.fileName}</strong>
              <small>Saved to {hostedComputer.browserDownload.workspacePath} · {formatBytes(hostedComputer.browserDownload.bytesWritten)}</small>
            </span>
          </div>
        ) : null}
        {hostedComputer.browserError ? <small className="hosted-browser-launcher__error" role="alert">{hostedComputer.browserError}</small> : null}
      </section> : null}

      </details>
      <section className="rail-conversations" aria-labelledby="rail-conversations-title">
        <header><h2 id="rail-conversations-title">Conversations</h2><button type="button" onClick={onNewConversation} disabled={conversationBusy || !onNewConversation} aria-label="New conversation"><Plus size={18} /></button></header>
        {conversations.length ? <ul>{conversations.map((conversation) => <li key={conversation.id}><button type="button" disabled={conversationBusy} aria-current={activeConversationId === conversation.id ? "page" : undefined} onClick={() => onSelectConversation?.(conversation.id)}><span>{conversation.title}</span><time>{conversation.time}</time></button></li>)}</ul> : <p>Your conversations with {agentName} will appear here.</p>}
      </section>

      {screenOpen && screenPreviewUrl ? (
        <div ref={screenDialogRef} className="live-screen-modal" role="dialog" aria-modal="true" aria-label={`${agentName}'s screen`} tabIndex={-1}>
          <section className={`live-screen-modal__panel${localComputer.browserActive ? " live-screen-modal__panel--local" : ""}`}>
            <header>
              <span><strong>{localComputer.browserActive ? localComputer.browserTitle || `${agentName}'s Linux computer` : hostedComputer.browserTitle || `${agentName}'s screen`}</strong><small>{localComputer.browserActive ? localComputer.browserUrl : hostedComputer.browserUrl}</small></span>
              <span className="live-screen-modal__actions">
                {localComputer.browserActive ? (
                  <>
                    <button type="button" onClick={() => void localComputer.onGoBack().catch(() => undefined)} disabled={!localComputer.canGoBack || localComputer.controller !== "human" || localComputer.busy} aria-label="Go back" title={localComputer.controller === "human" ? "Go back" : "Take control to use browser history"}><ArrowLeft size={17} /></button>
                    <button type="button" onClick={() => void localComputer.onGoForward().catch(() => undefined)} disabled={!localComputer.canGoForward || localComputer.controller !== "human" || localComputer.busy} aria-label="Go forward" title={localComputer.controller === "human" ? "Go forward" : "Take control to use browser history"}><ArrowRight size={17} /></button>
                  </>
                ) : null}
                <button type="button" onClick={() => void (localComputer.browserActive ? localComputer.onRefreshBrowser() : hostedComputer.onRefreshBrowser()).catch(() => undefined)} disabled={hostedComputer.browserOpening || localComputer.busy} aria-label="Refresh screen preview"><ArrowClockwise size={17} /></button>
                {localComputer.recoveryNeeded ? (
                  <button type="button" onClick={() => void localComputer.onProvision().catch(() => undefined)} disabled={localComputer.provisioning || localComputer.loading}>
                    {localComputer.provisioning ? "Restarting…" : "Restart computer"}
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
                <strong>The private Linux computer needs to restart</strong>
                <small>{localComputer.error ?? "Fable lost contact with this computer session."}</small>
              </div>
            ) : localComputer.browserActive ? (
              <div
                className={`local-browser-screen${localComputer.controller === "human" ? " is-human" : ""}`}
                ref={localScreenRef}
                tabIndex={localComputer.controller === "human" ? 0 : -1}
                role="group"
                aria-label={`${agentName}'s interactive Linux computer`}
                onClick={handleLocalScreenClick}
                onWheel={handleLocalScreenWheel}
                onKeyDown={handleLocalScreenKey}
              >
                <img ref={localScreenImageRef} src={screenPreviewUrl} alt={`${agentName}'s Linux desktop`} draggable={false} />
                <small>{localComputer.controller === "human" ? `${formatControlLease(localComputer.leaseExpiresAt)} Click the desktop, then type; keys are sent directly and are not saved by Fable.` : `${agentName} controls this isolated computer. Take control to use the desktop yourself.`}</small>
              </div>
            ) : <img src={screenPreviewUrl} alt={`${agentName}'s live computer session`} />}
          </section>
        </div>
      ) : null}
      {localComputer.filePreview ? (
        <div ref={filePreviewDialogRef} className="live-screen-modal" role="dialog" aria-modal="true" aria-label={`${localComputer.filePreview.path} preview`}>
          <section className="live-screen-modal__panel local-file-preview__panel">
            <header>
              <span>
                <strong>{localComputer.filePreview.path}</strong>
                <small>{formatBytes(localComputer.filePreview.sizeBytes)} · private text preview{localComputer.filePreview.truncated ? " · truncated" : ""}</small>
              </span>
              <span className="live-screen-modal__actions">
                <button ref={filePreviewCloseRef} type="button" onClick={localComputer.onCloseFilePreview} aria-label="Close file preview"><X size={18} /></button>
              </span>
            </header>
            <div className="local-file-preview">
              <pre tabIndex={0}>{localComputer.filePreview.content}</pre>
              {!localComputer.filePreview.content ? <small>This file is empty.</small>
                : localComputer.filePreview.truncated ? <small>Preview stopped at 256 KB. The file itself is unchanged.</small>
                  : null}
            </div>
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

function formatControlLease(expiresAt?: string): string {
  if (!expiresAt) return "You have a renewable five-minute control lease.";
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return "You have a renewable five-minute control lease.";
  const time = expiry.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Control returns to the teammate automatically at ${time}.`;
}
