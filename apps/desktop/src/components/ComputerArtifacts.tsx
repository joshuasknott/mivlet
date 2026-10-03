import { useEffect, useRef, useState } from "react";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ArtifactThumbnail } from "./ArtifactThumbnail";
import { artifactSize, canOpenComputerArtifact, openComputerArtifact, parseComputerArtifact, saveComputerArtifact } from "../lib/computer-artifacts";
import "./ComputerArtifacts.css";

interface ComputerArtifactsProps {
  output: string;
  workspaceId: string;
  agentId: string;
  expectedGeneration: number | undefined;
  onPreview?: (output: string) => void;
  compact?: boolean;
}

export function ComputerArtifacts({ output, workspaceId, agentId, expectedGeneration, onPreview, compact = false }: ComputerArtifactsProps) {
  const artifact = parseComputerArtifact(output);
  const scope = `${workspaceId}\0${agentId}\0${expectedGeneration}\0${artifact?.id ?? ""}`;
  const currentScope = useRef({ scope, epoch: 0 });
  if (currentScope.current.scope !== scope) currentScope.current = { scope, epoch: currentScope.current.epoch + 1 };
  const epoch = currentScope.current.epoch;
  const opening = useRef<number | null>(null);
  const mounted = useRef(true);
  const [pendingEpoch, setPendingEpoch] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ epoch: number; message: string } | null>(null);
  const [savingEpoch, setSavingEpoch] = useState<number | null>(null);
  const [savedEpoch, setSavedEpoch] = useState<number | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!artifact) return null;
  const pending = pendingEpoch === epoch;
  const available = canOpenComputerArtifact() && expectedGeneration !== undefined && Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 0;
  const error = failure?.epoch === epoch ? failure.message : null;
  const inlineImage = !compact && artifact.mimeType.startsWith("image/") && available;
  const perform = async (action: "open" | "save") => {
    if (!available || pending || opening.current === epoch || expectedGeneration === undefined) return;
    opening.current = epoch;
    setPendingEpoch(epoch);
    setFailure(null);
    setSavedEpoch(null);
    setSavingEpoch(action === "save" ? epoch : null);
    try {
      const request = { workspaceId, agentId, artifactId: artifact.id, expectedGeneration };
      if (action === "save") {
        const saved = await saveComputerArtifact(request);
        if (saved && mounted.current && currentScope.current.epoch === epoch) setSavedEpoch(epoch);
      } else await openComputerArtifact(request);
    } catch (error) {
      if (mounted.current && currentScope.current.epoch === epoch) setFailure({ epoch, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (opening.current === epoch) opening.current = null;
      if (mounted.current && currentScope.current.epoch === epoch) setPendingEpoch(null);
    }
  };
  return (
    <div className={`computer-artifact${inlineImage ? " computer-artifact--image" : ""}${compact ? " computer-artifact--compact" : ""}`}>
      <button type="button" onClick={() => { if (onPreview) onPreview(output); else void perform("open"); }} disabled={!onPreview && (!available || pending)}
        aria-label={`${onPreview ? "Preview" : "Open"} ${artifact.title}`} aria-busy={pending} aria-disabled={!onPreview && (pending || !available)}
        title={onPreview ? "Preview this file" : available ? "Open in your default app" : "Open the computer in Mivlet to access this file"}
        className="computer-artifact__open">
        {inlineImage ? <ArtifactThumbnail key={scope} title={artifact.title} request={{ workspaceId, agentId, artifactId: artifact.id, expectedGeneration: expectedGeneration! }} /> : <FileText size={22} aria-hidden className="computer-artifact__icon" />}
        <span className="computer-artifact__copy">
          <span className="computer-artifact__title">{compact ? pending && savingEpoch !== epoch ? "Opening…" : "Open file" : artifact.title}</span>
          <span className="computer-artifact__meta">{compact ? "In your default app" : pending ? "Opening…" : `${artifact.relativePath.split(".").at(-1)?.toUpperCase()} · ${artifactSize(artifact.sizeBytes)}`}</span>
        </span>
      </button>
      {compact && <button className="computer-artifact__save" type="button" disabled={!available || pending}
        aria-label={`Save ${artifact.title}`} aria-busy={pending && savingEpoch === epoch}
        onClick={() => void perform("save")}>{pending && savingEpoch === epoch ? "Saving…" : "Save file"}</button>}
      {savedEpoch === epoch && <p role="status" className="computer-artifact__saved">File saved.</p>}
      {error && <p role="alert" className="computer-artifact__error">{error}</p>}
    </div>
  );
}
