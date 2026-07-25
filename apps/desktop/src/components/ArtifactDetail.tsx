import { useEffect, useRef, useState } from "react";
import {
  acceptRuntimeArtifactHandoff,
  exportRuntimeArtifact,
  getRuntimeArtifactSourceProjectId,
  proposeRuntimeArtifactHandoff,
  type RuntimeArtifactBundle,
  type RuntimeArtifactExport,
  type RuntimeArtifactHandoff
} from "../runtime";
import { listRuntimeProjects, type RuntimeProject } from "../lib/project-runtime";

export function plainArtifactStatus(status: string) {
  const labels: Record<string, string> = {
    draft: "Draft",
    "in-review": "Private review",
    "changes-requested": "Changes requested",
    accepted: "Accepted",
    published: "Published",
    archived: "Archived"
  };
  return labels[status] ?? status.replaceAll("-", " ");
}

function safePortableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePortableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:local|source)?path|locator|secret|token|credential|hidden/i.test(key))
    .map(([key, entry]) => [key, safePortableValue(entry)]));
}

export function artifactExportText(
  exported: RuntimeArtifactExport,
  versionNumber: number,
  format: "markdown" | "json"
) {
  const content = exported.content.kind === "inline" ? exported.content.text : "Stored content";
  const sources = exported.citations.map((citation) => ({
    label: citation.label,
    ...(citation.quotedText ? { excerpt: citation.quotedText } : {})
  }));
  if (format === "json") {
    return JSON.stringify({
      format: "fable.artifact.export.v1",
      title: exported.title,
      kind: exported.kind,
      version: versionNumber,
      exportedAt: exported.exportedAt,
      content,
      sources,
      inputs: safePortableValue(exported.inputs),
      decisions: safePortableValue(exported.decisions)
    }, null, 2);
  }
  return [
    `# ${exported.title}`,
    "",
    `Type: ${exported.kind}`,
    `Version: ${versionNumber}`,
    "",
    content,
    ...(sources.length ? ["", "## Sources", ...sources.map((source) =>
      `- ${source.label}${source.excerpt ? `: ${source.excerpt}` : ""}`
    )] : [])
  ].join("\n");
}

function downloadArtifactExport(
  exported: RuntimeArtifactExport,
  versionNumber: number,
  format: "markdown" | "json"
) {
  const text = artifactExportText(exported, versionNumber, format);
  const extension = format === "markdown" ? "md" : "json";
  const safeTitle = exported.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";
  const url = URL.createObjectURL(new Blob([text], {
    type: format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8"
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeTitle}-v${versionNumber}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ArtifactDetail({
  bundle,
  selectedVersionId,
  activeWorkspaceId,
  activeWorkspaceRef,
  onSelectVersion
}: {
  bundle: RuntimeArtifactBundle;
  selectedVersionId: string;
  activeWorkspaceId: string;
  activeWorkspaceRef: { current: string };
  onSelectVersion: (versionId: string) => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportError, setExportError] = useState("");
  const [eligibleProjects, setEligibleProjects] = useState<RuntimeProject[]>([]);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [preparedHandoff, setPreparedHandoff] = useState<RuntimeArtifactHandoff | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffStatus, setHandoffStatus] = useState("");
  const [handoffError, setHandoffError] = useState("");
  const confirmHandoffRef = useRef<HTMLButtonElement>(null);
  const handoffSuccessRef = useRef<HTMLParagraphElement>(null);
  const version = bundle.versions.find((entry) => entry.id === selectedVersionId) ?? bundle.currentVersion;
  const scopeLabel = bundle.artifact.context.projectId
    ? "Project"
    : bundle.artifact.context.threadId
      ? "Conversation"
      : "Workspace";
  const review = [...bundle.artifact.reviews].reverse().find((entry) => entry.versionId === version.id);
  useEffect(() => {
    let active = true;
    void Promise.all([
      listRuntimeProjects(activeWorkspaceId, true),
      getRuntimeArtifactSourceProjectId(bundle.artifact.id)
    ]).then(([projects, sourceProjectId]) => {
      if (!active || activeWorkspaceRef.current !== activeWorkspaceId) return;
      setEligibleProjects(projects.filter((project) =>
        project.lifecycle === "active" && project.authority === "local" &&
        project.visibility === "member-private" &&
        project.ownerMemberId === bundle.artifact.ownerMemberId &&
        project.id !== sourceProjectId
      ));
    }).catch(() => { if (active && activeWorkspaceRef.current === activeWorkspaceId) setEligibleProjects([]); });
    return () => { active = false; };
  }, [activeWorkspaceId, activeWorkspaceRef, bundle.artifact.id, bundle.artifact.ownerMemberId]);
  useEffect(() => {
    setTargetProjectId("");
    setPreparedHandoff(null);
    setHandoffStatus("");
    setHandoffError("");
  }, [version.id]);
  useEffect(() => { preparedHandoff && confirmHandoffRef.current?.focus(); }, [preparedHandoff]);
  useEffect(() => { handoffStatus && handoffSuccessRef.current?.focus(); }, [handoffStatus]);
  const runExport = (format: "markdown" | "json") => {
    const requestedWorkspaceId = activeWorkspaceId;
    setExporting(true);
    setExportError("");
    setExportStatus("");
    void exportRuntimeArtifact(bundle.artifact.id, version.id)
      .then((exported) => {
        if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
        downloadArtifactExport(exported, version.version, format);
        setExportStatus(`${format === "markdown" ? "Markdown" : "JSON"} export ready.`);
      })
      .catch((cause) => {
        if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
        setExportError(cause instanceof Error ? cause.message : "Fable could not export that version.");
      })
      .finally(() => {
        if (activeWorkspaceRef.current === requestedWorkspaceId) setExporting(false);
      });
  };
  const prepareHandoff = () => {
    if (!targetProjectId) return;
    const requestedWorkspaceId = activeWorkspaceId;
    setHandoffPending(true);
    setHandoffError("");
    setHandoffStatus("");
    void proposeRuntimeArtifactHandoff({
      artifactId: bundle.artifact.id,
      versionId: version.id,
      targetProjectId
    }).then((handoff) => {
      if (activeWorkspaceRef.current === requestedWorkspaceId) setPreparedHandoff(handoff);
    }).catch((cause) => {
      if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
      setHandoffError(cause instanceof Error ? cause.message : "Fable could not prepare that project handoff.");
    }).finally(() => {
      if (activeWorkspaceRef.current === requestedWorkspaceId) setHandoffPending(false);
    });
  };
  const confirmHandoff = () => {
    if (!preparedHandoff) return;
    const requestedWorkspaceId = activeWorkspaceId;
    setHandoffPending(true);
    setHandoffError("");
    void acceptRuntimeArtifactHandoff(preparedHandoff.id, preparedHandoff.revision)
      .then(() => {
        if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
        setPreparedHandoff(null);
        setTargetProjectId("");
        setHandoffStatus(`Version ${version.version} added to project.`);
      })
      .catch((cause) => {
        if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
        setHandoffError(cause instanceof Error ? cause.message : "Fable could not add that version to the project.");
      })
      .finally(() => {
        if (activeWorkspaceRef.current === requestedWorkspaceId) setHandoffPending(false);
      });
  };
  return (
    <section className="artifact-detail" aria-label={`Artifact details for ${bundle.artifact.title}`}>
      <dl>
        <div><dt>Type</dt><dd>{bundle.artifact.kind}</dd></div>
        <div><dt>Status</dt><dd>{plainArtifactStatus(bundle.artifact.status)}</dd></div>
        <div><dt>Scope</dt><dd>{scopeLabel}</dd></div>
        <div><dt>Origin</dt><dd>{bundle.artifact.producingRunId || bundle.currentVersion.provenance.kind === "run" ? "Created from a response" : "Saved artifact"}</dd></div>
      </dl>
      <label className="artifact-detail__version">
        <span>Version</span>
        <select disabled={handoffPending || preparedHandoff !== null} value={version.id} onChange={(event) => onSelectVersion(event.target.value)} aria-label={`Version of ${bundle.artifact.title}`}>
          {[...bundle.versions].reverse().map((entry) => (
            <option key={entry.id} value={entry.id}>Version {entry.version}{entry.id === bundle.currentVersion.id ? " - Current" : ""}</option>
          ))}
        </select>
      </label>
      <div className="artifact-detail__content">{version.content.kind === "inline" ? version.content.text : "Stored content"}</div>
      <p>Review: {review ? plainArtifactStatus(review.status) : "Not reviewed"}</p>
      {version.citations.length ? (
        <ul aria-label={`Sources for ${bundle.artifact.title}`}>
          {version.citations.map((citation) => <li key={citation.id}>{citation.label}</li>)}
        </ul>
      ) : <p>No external sources were used.</p>}
      <div className="artifact-detail__exports">
        <button type="button" disabled={exporting} onClick={() => runExport("markdown")}>Export {bundle.artifact.title} version {version.version} as Markdown</button>
        <button type="button" disabled={exporting} onClick={() => runExport("json")}>Export {bundle.artifact.title} version {version.version} as JSON</button>
      </div>
      {exportStatus ? <p role="status">{exportStatus}</p> : null}
      {exportError ? <p role="alert">{exportError}</p> : null}
      {eligibleProjects.length ? (
        <section className="artifact-handoff" aria-label={`Add ${bundle.artifact.title} to a project`}>
          <label>
            <span>Add to project</span>
            <select
              aria-label={`Project for ${bundle.artifact.title} version ${version.version}`}
              value={targetProjectId}
              disabled={handoffPending || preparedHandoff !== null}
              onChange={(event) => {
                setTargetProjectId(event.target.value);
                setPreparedHandoff(null);
                setHandoffError("");
              }}
            >
              <option value="">Choose a project</option>
              {eligibleProjects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
          </label>
          {targetProjectId ? <p>Adds this version only. Conversation history and permissions stay here.</p> : null}
          {targetProjectId && !preparedHandoff ? (
            <button type="button" disabled={handoffPending} onClick={prepareHandoff}>Prepare</button>
          ) : null}
          {preparedHandoff ? (
            <button ref={confirmHandoffRef} type="button" disabled={handoffPending} onClick={confirmHandoff}>
              Confirm add version {version.version}
            </button>
          ) : null}
          {handoffStatus ? <p ref={handoffSuccessRef} role="status" tabIndex={-1}>{handoffStatus}</p> : null}
          {handoffError ? <p role="alert">{handoffError}</p> : null}
        </section>
      ) : null}
    </section>
  );
}
