import { FormEvent, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Database,
  DownloadSimple,
  FilePlus,
  MagnifyingGlass,
  PlugsConnected,
  PushPin,
  Stack,
  Trash
} from "@phosphor-icons/react";
import type { KnowledgeSource, MemoryRecord } from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { PageHeader } from "../PageHeader";

type KnowledgeMode = "sources" | "memory";

export function KnowledgePage({ runtime }: { runtime: ShellRuntime }) {
  const [mode, setMode] = useState<KnowledgeMode>("sources");
  const [query, setQuery] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const sources = useMemo(
    () =>
      runtime.workspaceKnowledgeSources.filter((source) =>
        normalizedQuery
          ? `${source.title} ${source.provenance} ${source.contentPreview ?? ""}`
              .toLowerCase()
              .includes(normalizedQuery)
          : true
      ),
    [normalizedQuery, runtime.workspaceKnowledgeSources]
  );
  const memories = useMemo(
    () =>
      runtime.managedMemoryRecords.filter((memory) =>
        normalizedQuery
          ? `${memory.title} ${memory.value} ${memory.source}`
              .toLowerCase()
              .includes(normalizedQuery)
          : true
      ),
    [normalizedQuery, runtime.managedMemoryRecords]
  );
  const selectedSource =
    sources.find((source) => source.id === selectedSourceId) ?? sources[0];
  const selectedMemory =
    memories.find((memory) => memory.id === selectedMemoryId) ?? memories[0];

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) void runtime.searchKnowledge(query);
  };

  return (
    <>
      <PageHeader
        icon={Stack}
        title="Knowledge"
        description="Inspect what Fable can use, and keep durable memory deliberate."
      />
      <section className="knowledge-page" aria-label="Knowledge workspace">
        <div className="knowledge-toolbar">
          <div className="knowledge-mode" role="tablist" aria-label="Knowledge mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sources"}
              className={mode === "sources" ? "is-active" : ""}
              onClick={() => setMode("sources")}
            >
              Sources
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "memory"}
              className={mode === "memory" ? "is-active" : ""}
              onClick={() => setMode("memory")}
            >
              Memory
            </button>
          </div>
          <form className="knowledge-search" onSubmit={submitSearch}>
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${mode}`}
              aria-label={`Search ${mode}`}
            />
          </form>
          <div className="knowledge-toolbar__actions">
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
            <button type="button" onClick={runtime.triggerAttach}>
              <FilePlus size={16} />
              Import file
            </button>
            <button type="button" onClick={runtime.triggerFolderImport}>
              <FilePlus size={16} />
              Import folder
            </button>
            <button type="button" onClick={() => runtime.setActiveItem("Connectors")}>
              <PlugsConnected size={16} />
              Connect
            </button>
          </div>
        </div>

        {runtime.importStatus ? (
          <p className="knowledge-notice" role="status">{runtime.importStatus}</p>
        ) : null}

        {mode === "sources" ? (
          <SourceWorkspace
            sources={sources}
            selected={selectedSource}
            pinnedIds={runtime.pinnedSourceIds}
            onSelect={setSelectedSourceId}
            onPin={runtime.toggleSourcePin}
            onRefresh={runtime.refreshKnowledgeSource}
            onToggleDisabled={runtime.toggleKnowledgeSourceDisabled}
            onDelete={runtime.deleteKnowledgeSource}
            onRemember={runtime.promoteSourceToMemory}
            memoryDisabled={runtime.memoryDisabled}
          />
        ) : (
          <MemoryWorkspace
            memories={memories}
            selected={selectedMemory}
            disabled={runtime.memoryDisabled}
            runtime={runtime}
            onSelect={setSelectedMemoryId}
          />
        )}
      </section>
    </>
  );
}

function SourceWorkspace({
  sources,
  selected,
  pinnedIds,
  onSelect,
  onPin,
  onRefresh,
  onToggleDisabled,
  onDelete,
  onRemember,
  memoryDisabled
}: {
  sources: KnowledgeSource[];
  selected?: KnowledgeSource;
  pinnedIds: string[];
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onRefresh: (id: string) => Promise<void>;
  onToggleDisabled: (id: string) => void;
  onDelete: (id: string) => void;
  onRemember: (source: KnowledgeSource) => void;
  memoryDisabled: boolean;
}) {
  if (sources.length === 0) {
    return (
      <div className="knowledge-empty">
        <FilePlus size={22} />
        <strong>No sources yet</strong>
        <span>Import a local file or connect a provider to begin.</span>
      </div>
    );
  }
  return (
    <div className="knowledge-browser">
      <div className="knowledge-list" role="list">
        {sources.map((source) => (
          <button
            type="button"
            key={source.id}
            className={`knowledge-row${selected?.id === source.id ? " is-selected" : ""}`}
            onClick={() => onSelect(source.id)}
          >
            <span className={`source-state source-state--${source.status ?? "ok"}`} />
            <span>
              <strong>{source.title}</strong>
              <small>{source.provenance} · {source.freshness}</small>
            </span>
            {pinnedIds.includes(source.id) ? <PushPin size={14} weight="fill" /> : null}
          </button>
        ))}
      </div>
      {selected ? (
        <article className="knowledge-inspector">
          <div className="knowledge-inspector__heading">
            <div>
              <span>{selected.kind}</span>
              <h2>{selected.title}</h2>
            </div>
            <span className={`knowledge-status knowledge-status--${selected.status ?? "ok"}`}>
              {selected.disabled ? "Disabled" : selected.status ?? "Ready"}
            </span>
          </div>
          <dl>
            <div><dt>Provenance</dt><dd>{selected.provenance}</dd></div>
            <div><dt>Scope</dt><dd>{selected.scope?.level ?? "global"}</dd></div>
            <div><dt>Account</dt><dd>{selected.account ?? "Local workspace"}</dd></div>
            <div><dt>Freshness</dt><dd>{selected.freshness}</dd></div>
          </dl>
          {selected.statusMessage ? <p className="knowledge-warning">{selected.statusMessage}</p> : null}
          <p className="knowledge-preview">
            {selected.contentPreview || "No content preview is retained for this source."}
          </p>
          <div className="knowledge-inspector__actions">
            <button type="button" onClick={() => onPin(selected.id)}>
              <PushPin size={15} />
              {pinnedIds.includes(selected.id) ? "Unpin" : "Pin"}
            </button>
            <button type="button" onClick={() => void onRefresh(selected.id)}>
              <ArrowClockwise size={15} />
              Refresh
            </button>
            <button type="button" onClick={() => onToggleDisabled(selected.id)}>
              {selected.disabled ? "Enable" : "Disable"}
            </button>
            <button
              type="button"
              disabled={memoryDisabled || selected.disabled}
              onClick={() => onRemember(selected)}
            >
              <Database size={15} />
              Remember
            </button>
            <button type="button" className="is-danger" onClick={() => onDelete(selected.id)}>
              <Trash size={15} />
              Delete
            </button>
          </div>
        </article>
      ) : null}
    </div>
  );
}

function MemoryWorkspace({
  memories,
  selected,
  disabled,
  runtime,
  onSelect
}: {
  memories: MemoryRecord[];
  selected?: MemoryRecord;
  disabled: boolean;
  runtime: ShellRuntime;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="memory-mode-bar">
        <span>{disabled ? "Memory is disabled; saved records remain inspectable." : "Only explicitly approved memory is used."}</span>
        <div>
          <button type="button" onClick={() => void runtime.exportMemory()}>
            <DownloadSimple size={15} /> Export
          </button>
          <button type="button" onClick={runtime.toggleMemoryDisabled}>
            {disabled ? "Enable memory" : "Disable memory"}
          </button>
        </div>
      </div>
      {memories.length === 0 ? (
        <div className="knowledge-empty">
          <Database size={22} />
          <strong>No durable memory</strong>
          <span>Promote a source or completed result when it is worth keeping.</span>
        </div>
      ) : (
        <div className="knowledge-browser">
          <div className="knowledge-list" role="list">
            {memories.map((memory) => (
              <button
                type="button"
                key={memory.id}
                className={`knowledge-row${selected?.id === memory.id ? " is-selected" : ""}`}
                onClick={() => onSelect(memory.id)}
              >
                <Database size={15} />
                <span>
                  <strong>{memory.title}</strong>
                  <small>{memory.source} · {memory.freshness}</small>
                </span>
                {memory.pinned ? <PushPin size={14} weight="fill" /> : null}
              </button>
            ))}
          </div>
          {selected ? (
            <article className="knowledge-inspector">
              <div className="knowledge-inspector__heading">
                <div><span>{selected.kind}</span><h2>{selected.title}</h2></div>
                <span className="knowledge-status">{selected.approvalState ?? (selected.approved ? "Approved" : "Suggested")}</span>
              </div>
              {runtime.editingMemoryId === selected.id ? (
                <div className="knowledge-memory-edit">
                  <label>Title<input value={runtime.editingMemoryDraft.title} onChange={(event) => runtime.setEditingMemoryDraft({ ...runtime.editingMemoryDraft, title: event.target.value })} /></label>
                  <label>Memory<textarea value={runtime.editingMemoryDraft.value} onChange={(event) => runtime.setEditingMemoryDraft({ ...runtime.editingMemoryDraft, value: event.target.value })} /></label>
                  <div><button type="button" onClick={() => runtime.saveMemoryEdit(selected.id)}>Save</button><button type="button" onClick={runtime.cancelMemoryEdit}>Cancel</button></div>
                </div>
              ) : (
                <>
                  <p className="knowledge-preview">{selected.value}</p>
                  <dl>
                    <div><dt>Origin</dt><dd>{selected.provenance?.origin ?? selected.source}</dd></div>
                    <div><dt>Scope</dt><dd>{selected.scope?.level ?? "global"}</dd></div>
                    <div><dt>Freshness</dt><dd>{selected.freshness}</dd></div>
                  </dl>
                  <div className="knowledge-inspector__actions">
                    <button type="button" onClick={() => runtime.startMemoryEdit(selected)}>Edit</button>
                    <button type="button" onClick={() => runtime.toggleMemoryPin(selected.id)}>
                      <PushPin size={15} /> {selected.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button type="button" className="is-danger" onClick={() => runtime.forgetMemory(selected.id)}>
                      <Trash size={15} /> Forget
                    </button>
                  </div>
                </>
              )}
            </article>
          ) : null}
        </div>
      )}
      <p className="memory-status" aria-live="polite">{runtime.memoryStatus}</p>
      {runtime.memoryExportText ? (
        <textarea className="memory-export" readOnly aria-label="Memory export" value={runtime.memoryExportText} />
      ) : null}
    </>
  );
}
