import { useEffect, useRef, useState } from "react";
import {
  appendRuntimeArtifactVersion,
  reviewRuntimeArtifact,
  type RuntimeArtifactBundle
} from "../runtime";

export function ResponseArtifactAction({
  existing,
  onSaved
}: {
  existing: RuntimeArtifactBundle;
  onSaved: (savedWork: RuntimeArtifactBundle) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changesNeeded, setChangesNeeded] = useState("");
  const changesInputRef = useRef<HTMLTextAreaElement>(null);
  const requestChangesButtonRef = useRef<HTMLButtonElement>(null);
  const reviewStatusRef = useRef<HTMLSpanElement>(null);

  const artifact = existing;
  const sourceCount = artifact.currentVersion.citations.length;
  const regionId = `saved-work-${artifact.artifact.id}`;
  const reviewStatusLabel = ({
    draft: "Draft",
    "in-review": "Private review",
    "changes-requested": "Changes requested",
    accepted: "Accepted"
  } as const)[artifact.artifact.status as "draft" | "in-review" | "changes-requested" | "accepted"]
    ?? artifact.artifact.status.replaceAll("-", " ");

  useEffect(() => {
    if (requestingChanges) changesInputRef.current?.focus();
  }, [requestingChanges]);

  const saveNewVersion = () => {
    setSaving(true);
    setError("");
    setNotice("");
    void appendRuntimeArtifactVersion({
      artifactId: artifact.artifact.id,
      expectedRevision: artifact.artifact.revision,
      expectedCurrentVersionId: artifact.currentVersion.id,
      content: draft
    }).then((saved) => {
      onSaved(saved);
      setEditing(false);
      setNotice(`Version ${saved.currentVersion.version} saved.`);
    }).catch((cause) => {
      setError(cause instanceof Error
        ? cause.message.replace(/\bartifact\b/gi, "saved work")
        : "Could not save a new version.");
    }).finally(() => setSaving(false));
  };

  const submitReviewAction = (
    action: "request-review" | "accept" | "request-changes",
    requestedChanges?: readonly string[]
  ) => {
    setSaving(true);
    setError("");
    setNotice("");
    void reviewRuntimeArtifact({
      artifactId: artifact.artifact.id,
      versionId: artifact.currentVersion.id,
      expectedRevision: artifact.artifact.revision,
      action,
      ...(requestedChanges ? { requestedChanges } : {})
    }).then((saved) => {
      onSaved(saved);
      setRequestingChanges(false);
      setChangesNeeded("");
      if (action === "request-changes") {
        window.setTimeout(() => reviewStatusRef.current?.focus(), 0);
      }
      setNotice(action === "request-review"
        ? "Private review started."
        : action === "accept"
          ? "Marked accepted."
          : "Changes requested.");
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Could not update this review.");
    }).finally(() => setSaving(false));
  };

  return (
    <div className="response-artifact">
      <button
        type="button"
        disabled={saving}
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={`${open ? "Hide" : "View"} saved work ${artifact.artifact.title}`}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide saved work" : "View saved work"}
      </button>
      {sourceCount > 0 ? <span>{sourceCount} {sourceCount === 1 ? "source" : "sources"}</span> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status" aria-live="polite">{notice}</p> : null}
      {open ? (
        <section id={regionId} aria-label="Saved work">
          <header className="response-artifact__header">
            <strong>{artifact.artifact.title}</strong>
            <div className="response-artifact__meta">
              <span>Version {artifact.currentVersion.version}</span>
              <span ref={reviewStatusRef} className="response-artifact__review-status" tabIndex={-1}>{reviewStatusLabel}</span>
            </div>
          </header>
          {editing ? (
            <div className="response-artifact__editor">
              <label htmlFor={`${regionId}-editor`}>Edit saved work</label>
              <textarea
                id={`${regionId}-editor`}
                value={draft}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="response-artifact__editor-actions">
                <button type="button" disabled={saving} aria-label={`Save new version of ${artifact.artifact.title}`} onClick={saveNewVersion}>
                  {saving ? "Saving..." : "Save new version"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  aria-label={`Cancel editing ${artifact.artifact.title}`}
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
              {artifact.currentVersion.content.kind === "inline" && artifact.artifact.status !== "in-review" ? (
                <button
                  type="button"
                  aria-label={`Edit ${artifact.artifact.title}`}
                  onClick={() => {
                    setDraft(artifact.currentVersion.content.kind === "inline" ? artifact.currentVersion.content.text : "");
                    setEditing(true);
                    setError("");
                    setNotice("");
                  }}
                >
                  Edit
                </button>
              ) : null}
              {artifact.artifact.status === "in-review" ? (
                <p className="response-artifact__review-lock">Resolve private review before editing.</p>
              ) : null}
              <div className="response-artifact__review-actions">
                {artifact.artifact.status === "draft" ? (
                  <button type="button" disabled={saving} aria-label={`Start private review for ${artifact.artifact.title}`} onClick={() => submitReviewAction("request-review")}>Start private review</button>
                ) : null}
                {artifact.artifact.status === "in-review" ? (
                  <>
                    <button type="button" disabled={saving} aria-label={`Mark ${artifact.artifact.title} accepted`} onClick={() => submitReviewAction("accept")}>Mark accepted</button>
                    <button ref={requestChangesButtonRef} type="button" disabled={saving} aria-label={`Request changes to ${artifact.artifact.title}`} onClick={() => { setRequestingChanges(true); setError(""); setNotice(""); }}>Request changes</button>
                  </>
                ) : null}
              </div>
              {requestingChanges ? (
                <div className="response-artifact__changes">
                  <label htmlFor={`${regionId}-changes`}>Changes needed</label>
                  <textarea
                    ref={changesInputRef}
                    id={`${regionId}-changes`}
                    aria-label={`Changes needed for ${artifact.artifact.title}`}
                    value={changesNeeded}
                    maxLength={2000}
                    disabled={saving}
                    onChange={(event) => setChangesNeeded(event.target.value)}
                  />
                  <div className="response-artifact__editor-actions">
                    <button
                      type="button"
                      disabled={saving || !changesNeeded.trim()}
                      aria-label={`Confirm changes for ${artifact.artifact.title}`}
                      onClick={() => submitReviewAction("request-changes", [changesNeeded.trim()])}
                    >
                      Confirm changes
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label={`Cancel requested changes for ${artifact.artifact.title}`}
                      onClick={() => { requestChangesButtonRef.current?.focus(); setRequestingChanges(false); setChangesNeeded(""); setError(""); }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
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
            <ul aria-label="Saved work sources">
              {artifact.currentVersion.citations.map((citation) => <li key={citation.id}>{citation.label}</li>)}
            </ul>
          ) : <p>No external sources were used.</p>}
        </section>
      ) : null}
    </div>
  );
}
