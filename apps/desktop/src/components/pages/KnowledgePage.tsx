import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { File } from "@phosphor-icons/react/dist/csr/File";
import { FilePlus } from "@phosphor-icons/react/dist/csr/FilePlus";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { Lightbulb } from "@phosphor-icons/react/dist/csr/Lightbulb";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PushPin } from "@phosphor-icons/react/dist/csr/PushPin";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import type { KnowledgeSource, MemoryRecord, SourceStatus } from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import {
  exportRuntimeArtifact,
  getRuntimeArtifact,
  searchRuntimeArtifacts,
  type RuntimeArtifactBundle,
  type RuntimeArtifactExport,
  type RuntimeArtifactSearchResult
} from "../../runtime";

type KnowledgeSection = "sources" | "memories" | "artifacts";
type SearchScope = "everything" | KnowledgeSection;
type SortOrder = "newest" | "oldest";

const sectionDetails: Array<{
  id: KnowledgeSection;
  label: string;
  description: string;
}> = [
  { id: "sources", label: "Sources", description: "Files, links and notes" },
  { id: "memories", label: "Memories", description: "Things Fable remembers" },
  { id: "artifacts", label: "Artifacts", description: "Work Fable has made" }
];

/** Human label for a source lifecycle/health status. */
function statusLabel(status: SourceStatus | undefined): string | null {
  switch (status) {
    case "indexing":
      return "Indexing";
    case "stale":
      return "Stale";
    case "error":
      return "Failed";
    case "ok":
      return null;
    default:
      return null;
  }
}

export function KnowledgePage({ runtime }: { runtime: ShellRuntime }) {
  const [section, setSection] = useState<KnowledgeSection>("sources");
  const [scope, setScope] = useState<SearchScope>("everything");
  const [query, setQuery] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const [artifactResults, setArtifactResults] = useState<RuntimeArtifactSearchResult[]>([]);
  const [artifactDetails, setArtifactDetails] = useState<Record<string, RuntimeArtifactBundle>>({});
  const [expandedArtifactId, setExpandedArtifactId] = useState<string | null>(null);
  const [selectedArtifactVersionId, setSelectedArtifactVersionId] = useState("");
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const activeWorkspaceId = runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const activeWorkspaceRef = useRef(activeWorkspaceId);
  activeWorkspaceRef.current = activeWorkspaceId;

  useEffect(() => {
    if (section !== "artifacts") return;
    let active = true;
    setArtifactResults([]);
    setArtifactDetails({});
    setExpandedArtifactId(null);
    setArtifactLoading(true);
    setArtifactError("");
    void searchRuntimeArtifacts({ ...(query.trim() ? { query: query.trim() } : {}), limit: 100 })
      .then((results) => { if (active) setArtifactResults(results); })
      .catch((cause) => {
        if (active) {
          setArtifactResults([]);
          setArtifactError(cause instanceof Error ? cause.message : "Fable could not load artifacts.");
        }
      })
      .finally(() => { if (active) setArtifactLoading(false); });
    return () => { active = false; };
  }, [activeWorkspaceId, query, section]);

  // Management lists: sources show disabled rows (with a badge + re-enable) so
  // the user can manage them, but disabled/forgotten material is excluded from
  // the global search results below.
  const managementSources = useMemo(
    () => runtime.workspaceKnowledgeSources,
    [runtime.workspaceKnowledgeSources]
  );
  const managementMemories = useMemo(
    () => runtime.managedMemoryRecords.filter((memory) => !memory.forgottenAt),
    [runtime.managedMemoryRecords]
  );

  const filteredSources = useMemo(() => {
    const matches = managementSources.filter((source) => {
      const matchesQuery =
        !normalizedQuery ||
        `${source.title} ${source.provenance} ${source.contentPreview ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery);
      const matchesPin = !pinnedOnly || runtime.pinnedSourceIds.includes(source.id);
      return matchesQuery && matchesPin;
    });
    return sortSources(matches, sortOrder);
  }, [
    normalizedQuery,
    pinnedOnly,
    runtime.pinnedSourceIds,
    managementSources,
    sortOrder
  ]);

  const filteredMemories = useMemo(() => {
    const matches = managementMemories.filter((memory) => {
      const matchesQuery =
        !normalizedQuery ||
        `${memory.title} ${memory.value} ${memory.source}`
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesQuery && (!pinnedOnly || memory.pinned);
    });
    return sortMemories(matches, sortOrder);
  }, [normalizedQuery, pinnedOnly, managementMemories, sortOrder]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim() && (scope === "everything" || scope === "sources")) {
      void runtime.searchKnowledge(query);
    }
  };

  const selectSection = (nextSection: KnowledgeSection) => {
    setSection(nextSection);
    setScope(nextSection);
  };

  const selectScope = (nextScope: SearchScope) => {
    setScope(nextScope);
    if (nextScope !== "everything") setSection(nextScope);
  };

  const showingGlobalResults = scope === "everything" && normalizedQuery.length > 0;

  // Global search results exclude disabled sources and disabled memories so
  // excluded material never appears in retrieval/citation views. (Forgotten
  // memories are already absent from the management list.)
  const searchSources = useMemo(
    () => filteredSources.filter((source) => !source.disabled),
    [filteredSources]
  );
  const searchMemories = useMemo(
    () => filteredMemories.filter((memory) => !memory.disabled),
    [filteredMemories]
  );

  return (
    <section className="knowledge-page" aria-label="Knowledge workspace">
      <header className="knowledge-page__header">
        <h1>Knowledge</h1>
        <p>Find and manage what Fable knows about your work.</p>
      </header>

      <form className="knowledge-search" onSubmit={submitSearch}>
        <MagnifyingGlass size={23} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={scope === "everything" ? "Search everything" : `Search ${scope}`}
          aria-label={scope === "everything" ? "Search everything" : `Search ${scope}`}
        />
        <label className="knowledge-search__scope">
          <span className="sr-only">Search in</span>
          <select
            value={scope}
            onChange={(event) => selectScope(event.target.value as SearchScope)}
            aria-label="Search in"
          >
            <option value="everything">Everything</option>
            <option value="sources">Sources</option>
            <option value="memories">Memories</option>
            <option value="artifacts">Artifacts</option>
          </select>
          <CaretDown size={16} aria-hidden="true" />
        </label>
      </form>

      <nav className="knowledge-sections" role="tablist" aria-label="Knowledge sections">
        {sectionDetails.map((item) => {
          const count =
            item.id === "sources"
              ? managementSources.filter((source) => !source.disabled).length
              : item.id === "memories"
                ? managementMemories.filter((memory) => !memory.disabled).length
                : artifactResults.length;
          return (
            <button
              type="button"
              role="tab"
              key={item.id}
              aria-label={item.label}
              aria-selected={section === item.id && !showingGlobalResults}
              className={section === item.id && !showingGlobalResults ? "is-active" : ""}
              onClick={() => selectSection(item.id)}
            >
              <span className="knowledge-sections__label">
                {item.label}
                <small>{count}</small>
              </span>
              <span className="knowledge-sections__description">{item.description}</span>
            </button>
          );
        })}
      </nav>

      <div className={`knowledge-list-toolbar${section === "artifacts" ? " knowledge-list-toolbar--artifacts" : ""}`}>
        {section !== "artifacts" ? <>
        <label className="knowledge-pin-filter">
          <PushPin size={18} aria-hidden="true" />
          <span>Pinned only</span>
          <input
            type="checkbox"
            checked={pinnedOnly}
            onChange={(event) => setPinnedOnly(event.target.checked)}
          />
        </label>
        <label className="knowledge-sort">
          <span className="sr-only">Sort items</span>
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value as SortOrder)}
            aria-label="Sort items"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          <CaretDown size={15} aria-hidden="true" />
        </label>
        </> : null}
        {section === "sources" && !showingGlobalResults ? (
          <SourceAddMenu runtime={runtime} />
        ) : null}
        {section === "memories" && !showingGlobalResults ? (
          <div className="knowledge-memory-actions">
            <button type="button" onClick={() => void runtime.exportKnowledge()}>
              <DownloadSimple size={17} />
              Export knowledge
            </button>
            <button type="button" onClick={() => void runtime.exportMemory()}>
              <DownloadSimple size={17} />
              Export memories
            </button>
            <button type="button" onClick={runtime.toggleMemoryDisabled}>
              {runtime.memoryDisabled ? "Turn memory on" : "Turn memory off"}
            </button>
          </div>
        ) : null}
      </div>

      {runtime.importStatus ? (
        <p className="knowledge-notice" role="status">
          {runtime.importStatus}
        </p>
      ) : null}

      {showingGlobalResults ? (
        <GlobalResults
          sources={searchSources}
          memories={searchMemories}
          runtime={runtime}
          expandedSourceId={expandedSourceId}
          expandedMemoryId={expandedMemoryId}
          onExpandSource={setExpandedSourceId}
          onExpandMemory={setExpandedMemoryId}
        />
      ) : section === "sources" ? (
        <SourceList
          sources={filteredSources}
          runtime={runtime}
          expandedId={expandedSourceId}
          onExpand={setExpandedSourceId}
        />
      ) : section === "memories" ? (
        <MemoryList
          memories={filteredMemories}
          runtime={runtime}
          expandedId={expandedMemoryId}
          onExpand={setExpandedMemoryId}
        />
      ) : (
        <ArtifactResults
          results={artifactResults}
          details={artifactDetails}
          expandedId={expandedArtifactId}
          selectedVersionId={selectedArtifactVersionId}
          loading={artifactLoading}
          error={artifactError}
          onSelectVersion={setSelectedArtifactVersionId}
          onToggle={(artifactId) => {
            if (expandedArtifactId === artifactId) {
              setExpandedArtifactId(null);
              return;
            }
            setExpandedArtifactId(artifactId);
            const existing = artifactDetails[artifactId];
            if (existing) {
              setSelectedArtifactVersionId(existing.currentVersion.id);
              return;
            }
            setArtifactError("");
            const requestedWorkspaceId = activeWorkspaceId;
            void getRuntimeArtifact(artifactId).then((bundle) => {
              if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
              if (!bundle) throw new Error("This artifact is no longer available.");
              setArtifactDetails((current) => ({ ...current, [artifactId]: bundle }));
              setSelectedArtifactVersionId(bundle.currentVersion.id);
            }).catch((cause) => {
              if (activeWorkspaceRef.current !== requestedWorkspaceId) return;
              setArtifactError(cause instanceof Error ? cause.message : "Fable could not open that artifact.");
            });
          }}
        />
      )}

      {section === "memories" && !showingGlobalResults && runtime.memoryStatus ? (
        <p className="memory-status" aria-live="polite">
          {runtime.memoryStatus}
        </p>
      ) : null}
      {section === "memories" && !showingGlobalResults && runtime.memoryExportText ? (
        <textarea
          className="memory-export"
          readOnly
          aria-label="Memory export"
          value={runtime.memoryExportText}
        />
      ) : null}
      {section === "memories" && !showingGlobalResults && runtime.knowledgeExportText ? (
        <textarea
          className="memory-export"
          readOnly
          aria-label="Knowledge export"
          value={runtime.knowledgeExportText}
        />
      ) : null}
    </section>
  );
}

function plainArtifactStatus(status: string) {
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

function ArtifactResults({
  results,
  details,
  expandedId,
  selectedVersionId,
  loading,
  error,
  onToggle,
  onSelectVersion
}: {
  results: RuntimeArtifactSearchResult[];
  details: Record<string, RuntimeArtifactBundle>;
  expandedId: string | null;
  selectedVersionId: string;
  loading: boolean;
  error: string;
  onToggle: (artifactId: string) => void;
  onSelectVersion: (versionId: string) => void;
}) {
  if (loading) return <p className="artifact-state" role="status">Loading artifacts...</p>;
  if (error) return <p className="artifact-state" role="alert">{error}</p>;
  if (results.length === 0) {
    return <EmptyState icon={Sparkle} title="No artifacts found" description="Save a useful response to see it here." />;
  }
  return (
    <ul className="artifact-list" aria-label="Artifacts">
      {results.map((result) => {
        const artifact = result.artifact;
        const open = expandedId === artifact.id;
        const detail = details[artifact.id];
        return (
          <li key={artifact.id}>
            <button
              type="button"
              className="artifact-list__row"
              aria-expanded={open}
              onClick={() => onToggle(artifact.id)}
            >
              <span><strong>{artifact.title}</strong><small>{artifact.kind} - {plainArtifactStatus(artifact.status)}</small></span>
              <span>Version {result.currentVersion.version}</span>
            </button>
            {open ? detail ? (
              <ArtifactDetail
                bundle={detail}
                selectedVersionId={selectedVersionId || detail.currentVersion.id}
                onSelectVersion={onSelectVersion}
              />
            ) : <p className="artifact-state" role="status">Opening artifact...</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactDetail({
  bundle,
  selectedVersionId,
  onSelectVersion
}: {
  bundle: RuntimeArtifactBundle;
  selectedVersionId: string;
  onSelectVersion: (versionId: string) => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportError, setExportError] = useState("");
  const version = bundle.versions.find((entry) => entry.id === selectedVersionId) ?? bundle.currentVersion;
  const scopeLabel = bundle.artifact.context.projectId
    ? "Project"
    : bundle.artifact.context.threadId
      ? "Conversation"
      : "Workspace";
  const review = [...bundle.artifact.reviews].reverse().find((entry) => entry.versionId === version.id);
  const runExport = (format: "markdown" | "json") => {
    setExporting(true);
    setExportError("");
    setExportStatus("");
    void exportRuntimeArtifact(bundle.artifact.id, version.id)
      .then((exported) => {
        downloadArtifactExport(exported, version.version, format);
        setExportStatus(`${format === "markdown" ? "Markdown" : "JSON"} export ready.`);
      })
      .catch((cause) => setExportError(cause instanceof Error ? cause.message : "Fable could not export that version."))
      .finally(() => setExporting(false));
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
        <select value={version.id} onChange={(event) => onSelectVersion(event.target.value)} aria-label={`Version of ${bundle.artifact.title}`}>
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
    </section>
  );
}

function SourceAddMenu({ runtime }: { runtime: ShellRuntime }) {
  return (
    <div className="knowledge-add">
      <input
        ref={runtime.fileInputRef}
        type="file"
        hidden
        aria-label="Import local knowledge file"
        accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml"
        onChange={runtime.handleLocalKnowledgeFileChange}
      />
      <input
        ref={(node) => {
          runtime.folderInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
          node?.setAttribute("directory", "");
        }}
        type="file"
        hidden
        multiple
        aria-label="Import local knowledge folder"
        accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml"
        onChange={runtime.handleLocalKnowledgeFolderChange}
      />
      <details>
        <summary>
          <Plus size={17} />
          Add
          <CaretDown size={14} />
        </summary>
        <div className="knowledge-add__menu">
          <button type="button" onClick={runtime.triggerAttach}>
            <FilePlus size={17} />
            Import file
          </button>
          <button type="button" onClick={runtime.triggerFolderImport}>
            <FolderOpen size={17} />
            Import folder
          </button>
          <button type="button" onClick={() => runtime.setActiveItem("Connectors")}>
            <PlugsConnected size={17} />
            Connect a service
          </button>
        </div>
      </details>
    </div>
  );
}

function GlobalResults({
  sources,
  memories,
  runtime,
  expandedSourceId,
  expandedMemoryId,
  onExpandSource,
  onExpandMemory
}: {
  sources: KnowledgeSource[];
  memories: MemoryRecord[];
  runtime: ShellRuntime;
  expandedSourceId: string | null;
  expandedMemoryId: string | null;
  onExpandSource: (id: string | null) => void;
  onExpandMemory: (id: string | null) => void;
}) {
  if (sources.length === 0 && memories.length === 0) {
    return (
      <EmptyState
        icon={MagnifyingGlass}
        title="Nothing found"
        description="Try a different word or search another section."
      />
    );
  }

  return (
    <div className="knowledge-global-results">
      {sources.length > 0 ? (
        <section>
          <h2>Sources <span>{sources.length}</span></h2>
          <SourceList
            sources={sources}
            runtime={runtime}
            expandedId={expandedSourceId}
            onExpand={onExpandSource}
          />
        </section>
      ) : null}
      {memories.length > 0 ? (
        <section>
          <h2>Memories <span>{memories.length}</span></h2>
          <MemoryList
            memories={memories}
            runtime={runtime}
            expandedId={expandedMemoryId}
            onExpand={onExpandMemory}
          />
        </section>
      ) : null}
    </div>
  );
}

function SourceList({
  sources,
  runtime,
  expandedId,
  onExpand
}: {
  sources: KnowledgeSource[];
  runtime: ShellRuntime;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
}) {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState("");
  if (sources.length === 0) {
    return (
      <EmptyState
        icon={File}
        title="No sources here"
        description="Add a file, folder or connected service to begin."
      />
    );
  }

  return (
    <div className="knowledge-list" role="list">
      {updateError ? <p className="knowledge-notice knowledge-notice--error" role="alert">{updateError}</p> : null}
      {sources.map((source) => {
        const expanded = expandedId === source.id;
        const pinned = runtime.pinnedSourceIds.includes(source.id);
        const status = statusLabel(source.status);
        return (
          <article className={`knowledge-item${expanded ? " is-expanded" : ""}`} key={source.id}>
            <div className="knowledge-item__row">
              <button
                type="button"
                className="knowledge-item__main"
                aria-expanded={expanded}
                onClick={() => onExpand(expanded ? null : source.id)}
              >
                <File size={22} aria-hidden="true" />
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.provenance}</small>
                </span>
              </button>
              <span className="knowledge-item__date">{source.freshness}</span>
              <button
                type="button"
                className={`knowledge-item__pin${pinned ? " is-pinned" : ""}`}
                aria-label={`${pinned ? "Unpin" : "Pin"} ${source.title}`}
                onClick={() => runtime.toggleSourcePin(source.id)}
              >
                <PushPin size={18} weight={pinned ? "fill" : "regular"} />
              </button>
              <button
                type="button"
                className="knowledge-item__expand"
                aria-label={`${expanded ? "Close" : "Open"} ${source.title}`}
                onClick={() => onExpand(expanded ? null : source.id)}
              >
                {expanded ? <CaretDown size={18} /> : <CaretRight size={18} />}
              </button>
            </div>
            {source.disabled || status ? (
              <p className="knowledge-item__status" role="note">
                {source.disabled ? (
                  <>
                    <Warning size={14} aria-hidden="true" /> Disabled — excluded from search and agent context.
                  </>
                ) : null}
                {!source.disabled && status ? (
                  <>
                    <Warning size={14} aria-hidden="true" /> {status}
                    {source.statusMessage ? ` — ${source.statusMessage}` : ""}
                  </>
                ) : null}
              </p>
            ) : null}
            {expanded ? (
              <div className="knowledge-item__details">
                <p>{source.contentPreview || "No preview is available for this source."}</p>
                <ul className="knowledge-item__meta">
                  <li>Connector: {source.connectorId}</li>
                  {source.account ? <li>Account: {source.account}</li> : null}
                  <li>Trust: {source.trust ?? "untrusted"}</li>
                  {source.connectorId !== "local-files" ? (
                    <li>
                      {runtime.connectorManifests.some(
                        (connector) =>
                          connector.id === source.connectorId && connector.status === "connected"
                      )
                        ? "Connected"
                        : "Disconnected"}
                    </li>
                  ) : null}
                </ul>
                <div className="knowledge-item__actions">
                  <button
                    type="button"
                    disabled={runtime.memoryDisabled || source.disabled}
                    onClick={() => runtime.promoteSourceToMemory(source)}
                  >
                    <Database size={16} />
                    Save to memories
                  </button>
                  {source.connectorId === "local-files" ? (
                    <label className="knowledge-item__update-file">
                      <span><ArrowClockwise size={16} /> {updatingId === source.id ? "Updating..." : "Update file"}</span>
                      <input
                        className="sr-only"
                        type="file"
                        aria-label={`Choose the current version of ${source.title}`}
                        disabled={updatingId === source.id}
                        accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,text/plain,text/markdown,application/json,text/csv,application/yaml"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (!file) return;
                          setUpdatingId(source.id);
                          setUpdateError("");
                          void runtime.refreshKnowledgeSource(source.id, file)
                            .catch((cause) => setUpdateError(cause instanceof Error ? cause.message : "Fable could not update that file."))
                            .finally(() => setUpdatingId(null));
                        }}
                      />
                    </label>
                  ) : (
                    <button type="button" onClick={() => void runtime.refreshKnowledgeSource(source.id)}>
                      <ArrowClockwise size={16} /> Refresh
                    </button>
                  )}
                  <button type="button" onClick={() => runtime.toggleKnowledgeSourceDisabled(source.id)}>
                    {source.disabled ? "Use source" : "Stop using"}
                  </button>
                  <ConfirmButton
                    variant="danger"
                    icon={<Trash size={16} />}
                    label="Delete"
                    confirmLabel={`Confirm delete ${source.title}`}
                    confirmText="Delete"
                    onConfirm={() => runtime.deleteKnowledgeSource(source.id)}
                  />
                </div>
                {source.connectorId === "local-files" ? (
                  <p className="knowledge-item__update-help">Choose the current version of this file. Fable won't keep access to its location.</p>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function MemoryList({
  memories,
  runtime,
  expandedId,
  onExpand
}: {
  memories: MemoryRecord[];
  runtime: ShellRuntime;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
}) {
  if (memories.length === 0) {
    return (
      <EmptyState
        icon={Lightbulb}
        title="No memories here"
        description="Save something Fable should remember for future work."
      />
    );
  }

  return (
    <div className="knowledge-list" role="list">
      {memories.map((memory) => {
        const expanded = expandedId === memory.id;
        return (
          <article className={`knowledge-item${expanded ? " is-expanded" : ""}`} key={memory.id}>
            <div className="knowledge-item__row">
              <button
                type="button"
                className="knowledge-item__main"
                aria-expanded={expanded}
                onClick={() => onExpand(expanded ? null : memory.id)}
              >
                <Lightbulb size={22} aria-hidden="true" />
                <span>
                  <strong>{memory.title}</strong>
                  <small>{memory.source}</small>
                </span>
              </button>
              <span className="knowledge-item__date">{memory.freshness}</span>
              <button
                type="button"
                className={`knowledge-item__pin${memory.pinned ? " is-pinned" : ""}`}
                aria-label={`${memory.pinned ? "Unpin" : "Pin"} ${memory.title}`}
                onClick={() => runtime.toggleMemoryPin(memory.id)}
              >
                <PushPin size={18} weight={memory.pinned ? "fill" : "regular"} />
              </button>
              <button
                type="button"
                className="knowledge-item__expand"
                aria-label={`${expanded ? "Close" : "Open"} ${memory.title}`}
                onClick={() => onExpand(expanded ? null : memory.id)}
              >
                {expanded ? <CaretDown size={18} /> : <CaretRight size={18} />}
              </button>
            </div>
            {memory.disabled ? (
              <p className="knowledge-item__status" role="note">
                <Warning size={14} aria-hidden="true" /> Disabled — excluded from search, context, and export.
              </p>
            ) : null}
            {expanded ? (
              <div className="knowledge-item__details">
                {runtime.editingMemoryId === memory.id ? (
                  <div className="knowledge-memory-edit">
                    <label>
                      Name
                      <input
                        value={runtime.editingMemoryDraft.title}
                        onChange={(event) =>
                          runtime.setEditingMemoryDraft({
                            ...runtime.editingMemoryDraft,
                            title: event.target.value
                          })
                        }
                      />
                    </label>
                    <label>
                      Memory
                      <textarea
                        value={runtime.editingMemoryDraft.value}
                        onChange={(event) =>
                          runtime.setEditingMemoryDraft({
                            ...runtime.editingMemoryDraft,
                            value: event.target.value
                          })
                        }
                      />
                    </label>
                    <div className="knowledge-item__actions">
                      <button type="button" onClick={() => runtime.saveMemoryEdit(memory.id)}>
                        Save
                      </button>
                      <button type="button" onClick={runtime.cancelMemoryEdit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p>{memory.value}</p>
                    <div className="knowledge-item__actions">
                      <button type="button" onClick={() => runtime.startMemoryEdit(memory)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => runtime.toggleMemoryRecordDisabled(memory.id)}
                      >
                        {memory.disabled ? "Re-enable" : "Disable"}
                      </button>
                      <ConfirmButton
                        variant="danger"
                        icon={<Trash size={16} />}
                        label="Forget"
                        confirmLabel={`Confirm forget ${memory.title}`}
                        confirmText="Forget"
                        onConfirm={() => runtime.forgetMemory(memory.id)}
                      />
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

/**
 * A two-step confirmation button for destructive actions (delete source,
 * forget memory). The first click arms the action and reveals a confirm/cancel
 * pair with an explicit accessible name; the second click performs it. Cancelling
 * disarms it. This mirrors the established confirmation semantics used for
 * high-risk approvals without a modal dialog.
 */
function ConfirmButton({
  variant,
  icon,
  label,
  confirmLabel,
  confirmText,
  onConfirm
}: {
  variant: "danger";
  icon: React.ReactNode;
  label: string;
  confirmLabel: string;
  confirmText: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        className={variant === "danger" ? "is-danger" : ""}
        aria-label={confirmLabel}
        onClick={() => setArmed(true)}
      >
        {icon}
        {label}
      </button>
    );
  }
  return (
    <span className="knowledge-confirm" role="group" aria-label={confirmLabel}>
      <button
        type="button"
        className={variant === "danger" ? "is-danger" : ""}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmText}
      </button>
      <button type="button" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description
}: {
  icon: typeof File;
  title: string;
  description: string;
}) {
  return (
    <div className="knowledge-empty">
      <Icon size={26} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function sortSources(items: KnowledgeSource[], order: SortOrder) {
  return [...items].sort((a, b) => compareDates(a.importedAt, b.importedAt, order));
}

function sortMemories(items: MemoryRecord[], order: SortOrder) {
  return [...items].sort((a, b) =>
    compareDates(a.updatedAt ?? a.createdAt, b.updatedAt ?? b.createdAt, order)
  );
}

function compareDates(a: string | undefined, b: string | undefined, order: SortOrder) {
  const left = a ? Date.parse(a) || 0 : 0;
  const right = b ? Date.parse(b) || 0 : 0;
  return order === "newest" ? right - left : left - right;
}
