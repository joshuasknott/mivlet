import { useState } from "react";
import type { KnowledgeCitation } from "@fable/protocol";
import {
  createRuntimeResponseArtifact,
  type RuntimeArtifactBundle
} from "../runtime";

export function ResponseArtifactAction({
  threadId,
  messageId,
  runId,
  content,
  citations,
  existing,
  onSaved
}: {
  threadId: string;
  messageId: string;
  runId: string;
  content: string;
  citations: readonly KnowledgeCitation[];
  existing?: RuntimeArtifactBundle;
  onSaved: (artifact: RuntimeArtifactBundle) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const artifact = existing;
  const sourceCount = artifact?.version.citations.length ?? citations.length;
  return (
    <div className="response-artifact">
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          if (artifact) { setOpen((value) => !value); return; }
          setSaving(true);
          setError("");
          void createRuntimeResponseArtifact({
            threadId, messageId, runId,
            title: content.trim().split(/\r?\n/, 1)[0].slice(0, 80) || "Assistant response",
            content, citations
          }).then((saved) => { onSaved(saved); setOpen(true); })
            .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not save this artifact."))
            .finally(() => setSaving(false));
        }}
      >
        {artifact ? (open ? "Hide artifact" : "View artifact") : saving ? "Saving…" : "Save as artifact"}
      </button>
      {artifact && sourceCount > 0 ? <span>{sourceCount} {sourceCount === 1 ? "source" : "sources"}</span> : null}
      {error ? <p role="alert">{error}</p> : null}
      {artifact && open ? (
        <section aria-label="Saved artifact">
          <strong>{artifact.artifact.title}</strong>
          <p>{artifact.version.content.kind === "inline" ? artifact.version.content.text : "Stored content"}</p>
          {artifact.version.citations.length > 0 ? (
            <ul aria-label="Artifact sources">
              {artifact.version.citations.map((citation) => <li key={citation.id}>{citation.label}</li>)}
            </ul>
          ) : <p>No external sources were used.</p>}
        </section>
      ) : null}
    </div>
  );
}
