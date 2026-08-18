import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useState } from "react";

export function LiveWorkRail({
  agentName,
  running,
  status,
  transcript,
  runId,
  approvalCount,
  computerUseActive,
  screenPreviewUrl,
  onClose
}: {
  agentName: string;
  running: boolean;
  status: string;
  transcript: string;
  runId: string | null;
  approvalCount: number;
  computerUseActive: boolean;
  screenPreviewUrl?: string;
  onClose: () => void;
}) {
  const [screenOpen, setScreenOpen] = useState(false);
  const needsAttention = approvalCount > 0 || status === "awaiting-approval";
  return (
    <aside className="live-rail" aria-label="Live work">
      <header className="live-rail__header"><div><span>Live work</span><strong>{agentName}</strong></div><button type="button" onClick={onClose} aria-label="Close live work"><X size={17} /></button></header>

      {computerUseActive ? (
        <button className="live-screen" type="button" onClick={() => screenPreviewUrl && setScreenOpen(true)} disabled={!screenPreviewUrl}>
          {screenPreviewUrl ? <img src={screenPreviewUrl} alt={`${agentName}'s live screen`} /> : <span className="live-screen__empty"><Browser size={24} /><span>Computer use is active</span><small>The live screen will appear when the runtime publishes a frame.</small></span>}
          <span className="live-screen__label"><span>{agentName}&apos;s screen</span>{screenPreviewUrl ? <ArrowSquareOut size={14} /> : null}</span>
        </button>
      ) : null}

      <section className={`live-run-card${needsAttention ? " live-run-card--attention" : ""}`}>
        <div className="live-run-card__status">{running ? <span className="live-pulse" /> : <CheckCircle size={16} weight="fill" />}<strong>{needsAttention ? "Needs your approval" : running ? "In progress" : "Ready"}</strong></div>
        <p>{transcript.trim() || (running ? "Starting this run…" : "Send a message to begin work.")}</p>
        {runId ? <small>Run {runId.slice(0, 12)}</small> : null}
      </section>

      <section className="live-rail__timeline">
        <h3>Activity</h3>
        <div><span className={running ? "is-active" : ""}><Clock size={14} /></span><p><strong>{running ? "Agent is working" : "No active run"}</strong><small>{needsAttention ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"} waiting` : "Progress and tool activity appear here."}</small></p></div>
      </section>

      {screenOpen && screenPreviewUrl ? <div className="live-screen-modal" role="dialog" aria-modal="true" aria-label={`${agentName}'s screen`}><button type="button" onClick={() => setScreenOpen(false)} aria-label="Close screen"><X size={18} /></button><img src={screenPreviewUrl} alt={`${agentName}'s live computer session`} /></div> : null}
    </aside>
  );
}
