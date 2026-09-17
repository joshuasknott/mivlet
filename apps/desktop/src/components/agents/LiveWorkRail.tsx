import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { FileArrowDown } from "@phosphor-icons/react/dist/csr/FileArrowDown";
import { File } from "@phosphor-icons/react/dist/csr/File";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { NativeComputerPanel } from "./NativeComputerPanel";
import type { useLocalComputer } from "../../hooks/useLocalComputer";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CopyButton } from "../CopyButton";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export function LiveWorkRail({
  agentName,
  localComputer,
  hostedComputer,
  screenPreviewUrl,
  onClose
}: {
  agentName: string;
  localComputer: ReturnType<typeof useLocalComputer>;
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
    liveViewAvailable?: boolean;
    browserDownload?: { fileName: string; workspacePath: string; bytesWritten: number };
    onOpenBrowser: (url: string) => Promise<unknown>;
    onRefreshBrowser: () => Promise<unknown>;
    onOpenLiveView?: () => Promise<unknown>;
  };
  screenPreviewUrl?: string;
  onClose: () => void;
}) {
  const [screenOpen, setScreenOpen] = useState(false);
  const compact = useMediaQuery("(max-width: 850px)");
  const railRef = useRef<HTMLElement>(null);
  useModalFocusTrap({ active: compact, containerRef: railRef, onClose });
  const screenDialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ active: screenOpen && Boolean(screenPreviewUrl), containerRef: screenDialogRef, onClose: () => setScreenOpen(false) });
  const [browserUrl, setBrowserUrl] = useState("");
  const [filesOpen, setFilesOpen] = useState(true);
  const fileRefresh = useRef(localComputer.refreshFiles);
  fileRefresh.current = localComputer.refreshFiles;
  const fileComputerId = localComputer.node?.capabilities.includes("persistent-files") ? localComputer.node.computerId : undefined;
  useEffect(() => { if (filesOpen && fileComputerId) void fileRefresh.current().catch(() => undefined); }, [filesOpen, fileComputerId]);
  const filePreviewDialogRef = useRef<HTMLDivElement>(null);
  const filePreviewCloseRef = useRef<HTMLButtonElement>(null);
  const submitBrowser = (event: FormEvent) => {
    event.preventDefault();
    void hostedComputer.onOpenBrowser(browserUrl).then(() => setScreenOpen(true)).catch(() => undefined);
  };
  const toggleLocalFiles = () => {
    const next = !filesOpen;
    setFilesOpen(next);
  };
  const openLocalFile = (path: string) => {
    setScreenOpen(false);
    void localComputer.previewFile(path).catch(() => undefined);
  };
  useModalFocusTrap({
    active: Boolean(localComputer.filePreview),
    containerRef: filePreviewDialogRef,
    initialFocusRef: filePreviewCloseRef,
    onClose: localComputer.closeFilePreview
  });
  return (
    <aside ref={railRef} className="live-rail" role={compact ? "dialog" : undefined} aria-modal={compact || undefined} aria-label="Work" onKeyDown={(event) => {
      if (event.key === "Escape" && !compact && !screenOpen && !localComputer.filePreview) {
        event.stopPropagation(); onClose();
      }
    }}>
      <header className="live-rail__header"><strong>Computer</strong><button type="button" onClick={onClose} aria-label="Close work"><X size={17} /></button></header>
      <NativeComputerPanel key={localComputer.scopeKey} agentName={agentName} computer={localComputer} />
      <section className="local-computer-card" aria-label="Agent workspace files">
        {localComputer.node?.capabilities.includes("persistent-files") ? (
          <div className="local-computer-files">
            <div className="local-computer-files__toolbar">
              <button type="button" onClick={toggleLocalFiles} aria-expanded={filesOpen} aria-controls="local-computer-files-list">
                <FolderOpen size={15} aria-hidden="true" />
                <span>Files</span>
                <small>{localComputer.files ? `${localComputer.files.entries.length}${localComputer.files.truncated ? "+" : ""}` : "Private"}</small>
              </button>
              {filesOpen ? (
                <button type="button" onClick={() => void localComputer.refreshFiles().catch(() => undefined)} disabled={localComputer.filesLoading} aria-label="Refresh private files">
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
        ) : <p className="local-computer-files__unavailable">{localComputer.loading ? "Checking workspace files…" : "Refresh computer status to load this agent's private files."}</p>}
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
        {screenPreviewUrl ? <button type="button" onClick={() => setScreenOpen(true)}>Open hosted screen</button> : null}
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

      {screenOpen && screenPreviewUrl ? (
        <div ref={screenDialogRef} className="live-screen-modal" role="dialog" aria-modal="true" aria-label={`${agentName}'s screen`} tabIndex={-1}>
          <section className="live-screen-modal__panel">
            <header>
              <span><strong>{hostedComputer.browserTitle || `${agentName}'s screen`}</strong><small>{hostedComputer.browserUrl}</small></span>
              <span className="live-screen-modal__actions">
                <button type="button" onClick={() => void hostedComputer.onRefreshBrowser().catch(() => undefined)} disabled={hostedComputer.browserOpening} aria-label="Refresh screen preview"><ArrowClockwise size={17} /></button>
                {hostedComputer.liveViewAvailable ? <button type="button" onClick={() => void hostedComputer.onOpenLiveView?.().catch(() => undefined)}>Take over <ArrowSquareOut size={15} /></button> : null}
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
                <button ref={filePreviewCloseRef} type="button" onClick={localComputer.closeFilePreview} aria-label="Close file preview"><X size={18} /></button>
              </span>
            </header>
            <div className="local-file-preview">
              <CopyButton text={localComputer.filePreview.content} label={localComputer.filePreview.truncated ? "Copy preview" : "Copy file contents"} />
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
