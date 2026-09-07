import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { FileArrowDown } from "@phosphor-icons/react/dist/csr/FileArrowDown";
import { File } from "@phosphor-icons/react/dist/csr/File";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import restingWallpaper from "../../assets/computer-wallpaper.png";
import { useRef, useState, type FormEvent } from "react";
import type { LocalComputerApplication, LocalComputerFilePreview, LocalComputerFilesSnapshot } from "@fable/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export function LiveWorkRail({
  agentName,
  localComputer,
  hostedComputer,
  screenPreviewUrl,
  conversations = [],
  activeConversationId,
  conversationBusy = false,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  onClose
}: {
  agentName: string;
  localComputer: {
    available: boolean;
    status?: "unprovisioned" | "provisioning" | "ready" | "degraded" | "stopped" | "sleeping";
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
    controller: "agent" | "human" | "paused";
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
    onStop?: () => Promise<unknown>;
    onRestart?: () => Promise<unknown>;
    onUpdateSystem?: () => Promise<unknown>;
    onOpenViewer?: () => Promise<unknown>;
    onOpenBrowser: (url: string) => Promise<unknown>;
    onRefreshBrowser: () => Promise<unknown>;
    onGoBack: () => Promise<unknown>;
    onGoForward: () => Promise<unknown>;
    onRefreshFiles: () => Promise<unknown>;
    onPreviewFile: (path: string) => Promise<unknown>;
    onCloseFilePreview: () => void;
    onTakeControl: () => Promise<unknown>;
    onReturnControl: () => Promise<unknown>;
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
  onDeleteConversation?: (id: string) => void;
  onClose: () => void;
}) {
  const [screenOpen, setScreenOpen] = useState(false);
  const compact = useMediaQuery("(max-width: 920px)");
  const railRef = useRef<HTMLElement>(null);
  useModalFocusTrap({ active: compact, containerRef: railRef, onClose });
  const [computerDetailsOpen, setComputerDetailsOpen] = useState(false);
  const screenDialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ active: screenOpen && Boolean(screenPreviewUrl), containerRef: screenDialogRef, onClose: () => setScreenOpen(false) });
  const [browserUrl, setBrowserUrl] = useState("");
  const [localBrowserUrl, setLocalBrowserUrl] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const filePreviewDialogRef = useRef<HTMLDivElement>(null);
  const filePreviewCloseRef = useRef<HTMLButtonElement>(null);
  const submitBrowser = (event: FormEvent) => {
    event.preventDefault();
    void hostedComputer.onOpenBrowser(browserUrl).then(() => setScreenOpen(true)).catch(() => undefined);
  };
  const submitLocalBrowser = (event: FormEvent) => {
    event.preventDefault();
    void (async () => {
      if (localComputer.controller !== "human") await localComputer.onTakeControl();
      await localComputer.onOpenBrowser(localBrowserUrl);
      if (localComputer.onOpenViewer) await localComputer.onOpenViewer();
    })().catch(() => undefined);
  };
  const openLocalApplication = (application: LocalComputerApplication) => {
    void (async () => {
      if (localComputer.controller !== "human") await localComputer.onTakeControl();
      await localComputer.onLaunchApplication(application);
      if (localComputer.onOpenViewer) await localComputer.onOpenViewer();
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
  return (
    <aside ref={railRef} className="live-rail" role={compact ? "dialog" : undefined} aria-modal={compact || undefined} aria-label="Work">
      <header className="live-rail__header"><strong>{agentName}’s computer</strong><button type="button" onClick={onClose} aria-label="Close work"><X size={17} /></button></header>
      <section className="computer-overview" aria-label={`${agentName}'s computer`}>
        <button className="computer-overview__preview" type="button" onClick={() => {
          if (localComputer.browserActive && localComputer.onOpenViewer) void localComputer.onOpenViewer().catch(() => undefined);
          else if (screenPreviewUrl && !localComputer.browserActive) setScreenOpen(true);
          else setComputerDetailsOpen(true);
        }} aria-label={localComputer.browserActive || screenPreviewUrl ? `Open ${agentName}'s screen` : "Open computer setup"}>
          <img src={screenPreviewUrl ?? restingWallpaper} alt={screenPreviewUrl ? `${agentName}'s latest computer screen` : "Resting computer wallpaper preview"} />
          {!screenPreviewUrl ? <span>Computer preview</span> : null}
        </button>
        <p>{localComputer.recoveryNeeded ? "Computer needs attention" : localComputer.provisioning ? "Preparing computer…" : localComputer.status === "sleeping" ? "Computer is sleeping" : localComputer.status === "stopped" ? "Computer is stopped" : localComputer.controller === "paused" ? "Computer paused — choose who continues" : localComputer.browserActive || hostedComputer.runtimeActive ? (localComputer.controller === "human" ? "You have control" : "Computer is running") : "Computer is resting"}</p>
        {localComputer.controller === "paused" && localComputer.browserActive ? <div className="local-computer-apps">
          <button type="button" disabled={localComputer.busy} onClick={() => void localComputer.onReturnControl().catch(() => undefined)}>Let {agentName} continue</button>
          <button type="button" disabled={localComputer.busy} onClick={() => void localComputer.onTakeControl().catch(() => undefined)}>Take control</button>
        </div> : null}
        <button className="computer-overview__action" type="button" onClick={() => {
          if (localComputer.browserActive && localComputer.onOpenViewer) void localComputer.onOpenViewer().catch(() => undefined);
          else if (localComputer.status === "stopped" || localComputer.status === "sleeping") void localComputer.onProvision().catch(() => undefined);
          else if (screenPreviewUrl && !localComputer.browserActive) setScreenOpen(true);
          else setComputerDetailsOpen(true);
        }} disabled={localComputer.busy}>{screenPreviewUrl || localComputer.browserActive ? "Open computer" : localComputer.status === "stopped" || localComputer.status === "sleeping" ? "Start computer" : "Set up computer"}</button>
      </section>
      <details className="computer-details" open={computerDetailsOpen} onToggle={(event) => setComputerDetailsOpen(event.currentTarget.open)}>
      <summary>Computer options</summary>
      <section className={`hosted-computer-card local-computer-card${localComputer.recoveryNeeded || localComputer.status === "degraded" ? " is-attention" : localComputer.status === "ready" ? " is-ready" : ""}`} aria-label="Computer on this PC">
        <span className="hosted-computer-card__icon"><Browser size={18} weight={localComputer.status === "ready" ? "fill" : "regular"} /></span>
        <span className="hosted-computer-card__copy">
          <strong>Computer on this PC</strong>
          <small>{localComputer.recoveryNeeded
            ? localComputer.error ?? "The private Linux computer needs to restart."
            : localComputer.status === "sleeping"
              ? "Sleeping after being idle. Start it to restore the open applications."
            : localComputer.status === "stopped"
              ? "Stopped. Your saved files and browser profile are kept."
            : localComputer.status === "ready"
              ? localComputer.browserActive
                ? `${localComputer.browserProduct ?? "Private Linux desktop"} · persistent home and workspace`
                : "The private Linux desktop is ready. Start it when needed."
            : localComputer.provisioning || localComputer.status === "provisioning"
              ? "Building this agent's private Linux desktop…"
              : localComputer.browserAvailable
                ? "Docker/WSL isolation is ready for setup"
                : "Start Docker Desktop with its WSL 2 engine"}</small>
        </span>
        {localComputer.available && (localComputer.recoveryNeeded || localComputer.status !== "ready" || !localComputer.browserActive) ? (
          <button type="button" onClick={() => void localComputer.onProvision().catch(() => undefined)} disabled={localComputer.provisioning || localComputer.loading || !localComputer.browserAvailable}>
            {localComputer.recoveryNeeded || localComputer.status === "degraded" ? "Retry" : localComputer.status === "ready" || localComputer.status === "stopped" || localComputer.status === "sleeping" ? "Start" : "Set up"}
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
              aria-label="Page to open on this agent's local computer"
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
            <button type="button" onClick={() => openLocalApplication("writer")} disabled={localComputer.busy}>Writer</button>
            <button type="button" onClick={() => openLocalApplication("spreadsheet")} disabled={localComputer.busy}>Spreadsheet</button>
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
                    ) : <small>No files yet. This agent can create one after you approve a write.</small>}
                {localComputer.files?.truncated ? <small>Showing the first 200 entries.</small> : null}
                {localComputer.filePreviewError ? <small role="alert">{localComputer.filePreviewError}</small> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {localComputer.error && !localComputer.recoveryNeeded ? <small className="hosted-browser-launcher__error" role="alert">{localComputer.error}</small> : null}
        {localComputer.status !== "unprovisioned" && (localComputer.onStop || localComputer.onRestart || localComputer.onUpdateSystem) ? <div>
          <div className="local-computer-apps" aria-label="Computer lifecycle">
            {localComputer.onStop && localComputer.status !== "stopped" ? <button type="button" disabled={localComputer.busy} onClick={() => void localComputer.onStop?.().catch(() => undefined)}>Stop</button> : null}
            {localComputer.onRestart ? <button type="button" disabled={localComputer.busy} onClick={() => void localComputer.onRestart?.().catch(() => undefined)}>Restart</button> : null}
            {localComputer.onUpdateSystem ? <button type="button" disabled={localComputer.busy} onClick={() => void localComputer.onUpdateSystem?.().catch(() => undefined)}>Update system</button> : null}
          </div>
          <small className="local-computer-card__boundary">Save open work before stopping, restarting, or updating. Saved files and browser profiles are kept.</small>
        </div> : null}
        {localComputer.status === "ready" ? (
          <small className="local-computer-card__boundary">A separate Linux container holds this agent&apos;s persistent desktop, browser profile, terminal, and files. Human control uses a renewable five-minute lease.</small>
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
                  ? "Not set up for this agent"
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
        {conversations.length ? <ul>{conversations.map((conversation) => <li key={conversation.id}><button type="button" disabled={conversationBusy} aria-current={activeConversationId === conversation.id ? "page" : undefined} onClick={() => onSelectConversation?.(conversation.id)}><span>{conversation.title}</span><time>{conversation.time}</time></button>{onDeleteConversation ? <button className="rail-conversation-delete" type="button" disabled={conversationBusy} onClick={() => onDeleteConversation(conversation.id)} aria-label={`Delete conversation: ${conversation.title}`} title="Delete conversation"><Trash size={15} aria-hidden="true" /></button> : null}</li>)}</ul> : <p>Your conversations with {agentName} will appear here.</p>}
      </section>

      {screenOpen && screenPreviewUrl && !localComputer.browserActive ? (
        <div ref={screenDialogRef} className="live-screen-modal" role="dialog" aria-modal="true" aria-label={`${agentName}'s screen`} tabIndex={-1}>
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
