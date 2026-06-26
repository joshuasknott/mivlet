import {
  Check,
  Database,
  DownloadSimple,
  FileText,
  PencilSimple,
  Power,
  ShieldCheck,
  Stack,
  Trash,
  X
} from "@phosphor-icons/react";
import type {
  KnowledgeSource,
  MemoryRecord
} from "@arden/protocol";
import { SectionHeading } from "./primitives";

/**
 * Knowledge context panel: indexed sources (with pin and approve-to-memory
 * actions) on the left and the durable memory editor on the right.
 */

export function KnowledgePanel({
  sources,
  memory,
  memoryDisabled,
  editingMemoryId,
  editingMemoryDraft,
  memoryExportText,
  memoryStatus,
  pinnedSourceIds,
  onTogglePin,
  onPromoteSource,
  onStartMemoryEdit,
  onUpdateMemoryDraft,
  onSaveMemoryEdit,
  onCancelMemoryEdit,
  onForgetMemory,
  onToggleMemoryPin,
  onToggleMemoryDisabled,
  onExportMemory
}: {
  sources: KnowledgeSource[];
  memory: MemoryRecord[];
  memoryDisabled: boolean;
  editingMemoryId: string | null;
  editingMemoryDraft: Pick<MemoryRecord, "title" | "value">;
  memoryExportText: string;
  memoryStatus: string;
  pinnedSourceIds: string[];
  onTogglePin: (sourceId: string) => void;
  onPromoteSource: (source: KnowledgeSource) => void;
  onStartMemoryEdit: (record: MemoryRecord) => void;
  onUpdateMemoryDraft: (draft: Pick<MemoryRecord, "title" | "value">) => void;
  onSaveMemoryEdit: (recordId: string) => void;
  onCancelMemoryEdit: () => void;
  onForgetMemory: (recordId: string) => void;
  onToggleMemoryPin: (recordId: string) => void;
  onToggleMemoryDisabled: () => void;
  onExportMemory: () => void;
}) {
  return (
    <section className="context-panel context-panel--split" aria-label="Knowledge">
      <div>
        <SectionHeading title="Sources" meta={`${sources.length} indexed`} />
        <div className="source-list">
          {sources.map((source) => {
            const pinned = pinnedSourceIds.includes(source.id);
            return (
              <article
                className={`source-row${pinned ? " source-row--pinned" : ""}`}
                key={source.id}
              >
                <FileText size={19} />
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.provenance} - {source.freshness}</small>
                </span>
                <div className="source-actions">
                  <button
                    type="button"
                    onClick={() => onTogglePin(source.id)}
                    aria-label={`${pinned ? "Unpin" : "Pin"} ${source.title}`}
                  >
                    {pinned ? "Pinned" : "Pin"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onPromoteSource(source)}
                    disabled={memoryDisabled}
                    aria-label={`Approve to memory ${source.title}`}
                  >
                    <ShieldCheck size={14} />
                    <span>Memory</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div>
        <div className="memory-heading">
          <SectionHeading title="Memory" meta={memoryDisabled ? "disabled" : `${memory.length} saved`} />
          <div className="memory-toolbar">
            <button type="button" onClick={onExportMemory} aria-label="Export memory">
              <DownloadSimple size={15} />
              <span>Export</span>
            </button>
            <button
              type="button"
              onClick={onToggleMemoryDisabled}
              aria-label={memoryDisabled ? "Enable memory" : "Disable memory"}
            >
              <Power size={15} />
              <span>{memoryDisabled ? "Enable" : "Disable"}</span>
            </button>
          </div>
        </div>
        {memoryDisabled ? (
          <div className="memory-banner" role="status">
            Memory is disabled. Records stay local for inspection and export.
          </div>
        ) : null}
        <div className="memory-list">
          {memory.map((record) => (
            <article className="memory-row" key={record.id}>
              {editingMemoryId === record.id ? (
                <div className="memory-edit">
                  <label>
                    <span>Memory title</span>
                    <input
                      value={editingMemoryDraft.title}
                      onChange={(event) =>
                        onUpdateMemoryDraft({
                          ...editingMemoryDraft,
                          title: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Memory value</span>
                    <textarea
                      value={editingMemoryDraft.value}
                      onChange={(event) =>
                        onUpdateMemoryDraft({
                          ...editingMemoryDraft,
                          value: event.target.value
                        })
                      }
                    />
                  </label>
                  <div className="memory-actions">
                    <button
                      type="button"
                      onClick={() => onSaveMemoryEdit(record.id)}
                      aria-label={`Save ${record.title}`}
                    >
                      <Check size={15} />
                      <span>Save</span>
                    </button>
                    <button type="button" onClick={onCancelMemoryEdit} aria-label={`Cancel ${record.title}`}>
                      <X size={15} />
                      <span>Cancel</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="label-row">
                    <Database size={17} />
                    {record.kind}
                    {record.pinned ? " - pinned" : ""}
                  </span>
                  <strong>{record.title}</strong>
                  <p>{record.value}</p>
                  <small>{record.source} - {record.freshness}</small>
                  <div className="memory-actions">
                    <button
                      type="button"
                      onClick={() => onStartMemoryEdit(record)}
                      aria-label={`Edit ${record.title}`}
                    >
                      <PencilSimple size={15} />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleMemoryPin(record.id)}
                      aria-label={`${record.pinned ? "Unpin" : "Pin"} ${record.title}`}
                    >
                      <Stack size={15} />
                      <span>{record.pinned ? "Unpin" : "Pin"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onForgetMemory(record.id)}
                      aria-label={`Forget ${record.title}`}
                    >
                      <Trash size={15} />
                      <span>Forget</span>
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
        <p className="memory-status" aria-live="polite">
          {memoryStatus}
        </p>
        {memoryExportText ? (
          <textarea className="memory-export" aria-label="Memory export" readOnly value={memoryExportText} />
        ) : null}
      </div>
    </section>
  );
}
