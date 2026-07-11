import { useState } from "react";
import type { KnowledgeCitation } from "@fable/protocol";
import {
  appendRuntimeArtifactVersion,
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
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const artifact = existing;
  const sourceCount = artifact?.currentVersion.citations.length ?? citations.length;
  const regionId = `artifact-${messageId}`;

  const saveInitialArtifact = () => {
    setSaving(true);
    setError("");
    setStatus("");
    void createRuntimeResponseArtifact({
      threadId,
      messageId,
      runId,
      title: content.trim().split(/\r?\n/, 1)[0].slice(0, 80) || "Assistant response",
      content,
      citations
    }).then((saved) => {
      onSaved(saved);
      setOpen(true);
      setStatus("Artifact saved.");
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Could not save this artifact.");
    }).finally(() => setSaving(false));
  };

  const saveNewVersion = () => {
    if (!artifact) return;
    setSaving(true);
    setError("");
    setStatus("");
    void appendRuntimeArtifactVersion({
      artifactId: artifact.artifact.id,
      expectedRevision: artifact.artifact.revision,
      expectedCurrentVersionId: artifact.currentVersion.id,
      content: draft
    }).then((saved) => {
      onSaved(saved);
      setEditing(false);
      setStatus(`Version ${saved.currentVersion.version} saved.`);
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Could not save a new version.");
    }).finally(() => setSaving(false));
  };

  return (
    <div className="response-artifact">
      <button
        type="button"
        disabled={saving}
        aria-expanded={artifact ? open : undefined}
        aria-controls={artifact ? regionId : undefined}
        onClick={() => {
          if (artifact) setOpen((value) => !value);
          else saveInitialArtifact();
        }}
      >
        {artifact ? (open ? "Hide artifact" : "View artifact") : saving ? "Saving..." : "Save as artifact"}
      </button>
      {artifact && sourceCount > 0 ? <span>{sourceCount} {sourceCount === 1 ? "source" : "sources"}</span> : null}
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status" aria-live="polite">{status}</p> : null}
      {artifact && open ? (
        <section id={regionId} aria-label="Saved artifact">
          <header className="response-artifact__header">
            <strong>{artifact.artifact.title}</strong>
            <span>Version {artifact.currentVersion.version}</span>
          </header>
          {editing ? (
            <div className="response-artifact__editor">
              <label htmlFor={`${regionId}-editor`}>Edit artifact markdown</label>
              <textarea
                id={`${regionId}-editor`}
                value={draft}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="response-artifact__editor-actions">
                <button type="button" disabled={saving} onClick={saveNewVersion}>
                  {saving ? "Saving..." : "Save new version"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => { setEditing(false); setDraft(""); setError(""); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="response-artifact__content">
                {artifact.currentVersion.content.kind === "inline"
                  ? artifact.currentVersion.content.text
                  : "Stored content"}
              </div>
              {artifact.currentVersion.content.kind === "inline" ? (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(artifact.currentVersion.content.kind === "inline" ? artifact.currentVersion.content.text : "");
                    setEditing(true);
                    setError("");
                    setStatus("");
                  }}
                >
                  Edit
                </button>
              ) : null}
            </>
          )}
          <details className="response-artifact__history">
            <summary>Version history ({artifact.versions.length})</summary>
            <ol>
              {[...artifact.versions].reverse().map((version) => (
                <li key={version.id}>
                  Version {version.version}{version.id === artifact.currentVersion.id ? " - Current" : ""}
                </li>
              ))}
            </ol>
          </details>
          {artifact.currentVersion.citations.length > 0 ? (
            <ul aria-label="Artifact sources">
              {artifact.currentVersion.citations.map((citation) => <li key={citation.id}>{citation.label}</li>)}
            </ul>
          ) : <p>No external sources were used.</p>}
        </section>
      ) : null}
    </div>
  );
}
