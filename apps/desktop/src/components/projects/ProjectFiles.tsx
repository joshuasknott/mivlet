import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { useId, useMemo, useState } from "react";
import "./projects.css";
export interface ProjectFileItem {
  sourceId: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  provenance?: string;
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectFiles({
  files,
  eligibleSources,
  onAttach,
  onRemove,
  onImport,
  onOpen,
  compact = false,
  disabled = false,
  error,
  status,
}: {
  files: ProjectFileItem[];
  eligibleSources: ProjectFileItem[];
  onAttach: (sourceId: string) => void;
  onRemove: (sourceId: string) => void;
  onImport?: () => void;
  onOpen?: (sourceId: string) => void;
  compact?: boolean;
  disabled?: boolean;
  error?: string | null;
  status?: string | null;
}) {
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const attachedIds = useMemo(
    () => new Set(files.map((file) => file.sourceId)),
    [files],
  );
  const choices = eligibleSources.filter((source) => {
    if (attachedIds.has(source.sourceId)) return false;
    return source.name.toLowerCase().includes(query.trim().toLowerCase());
  });
  return (
    <section
      className={`project-files${compact ? " project-files--compact" : ""}`}
      aria-labelledby={compact ? undefined : headingId}
    >
      <header>
        <div>
          <h2 id={compact ? undefined : headingId}>
            {compact ? "Files" : "Project files"}
          </h2>
          {!compact ? (
            <p>Shared references and results available to this project.</p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding((value) => !value)}
          aria-label="Add project file"
          aria-expanded={adding}
        >
          <Plus size={17} aria-hidden="true" />
          {compact ? null : <span>Add file</span>}
        </button>
      </header>
      {adding ? (
        <div className="project-files__picker">
          {eligibleSources.length > 6 ? (
            <label className="project-picker-search">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <input
                autoFocus
                type="search"
                placeholder="Find an imported file"
                aria-label="Find an imported file"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          <div className="project-files__choices">
            {choices.map((source) => (
              <button
                type="button"
                disabled={disabled}
                key={source.sourceId}
                onClick={() => {
                  onAttach(source.sourceId);
                  setAdding(false);
                }}
              >
                <FileText size={18} aria-hidden="true" />
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.provenance ?? source.mediaType ?? "Imported file"}
                  </small>
                </span>
              </button>
            ))}
            {choices.length === 0 ? (
              <p>
                {eligibleSources.length
                  ? "All matching files are already attached."
                  : "No imported files are available."}
              </p>
            ) : null}
          </div>
          {onImport ? (
            <button
              className="project-files__import"
              type="button"
              disabled={disabled}
              onClick={onImport}
            >
              <Plus size={15} aria-hidden="true" />
              Import from computer
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p
          className="project-form-message project-form-message--error"
          role="alert"
        >
          {error}
        </p>
      ) : status ? (
        <p className="project-form-message" role="status">
          {status}
        </p>
      ) : null}
      <div className="project-files__list">
        {files.map((file) => {
          const size = formatBytes(file.sizeBytes);
          return (
            <div className="project-file" key={file.sourceId}>
              <FileText size={compact ? 20 : 23} aria-hidden="true" />
              {onOpen ? (
                <button
                  className="project-file__open"
                  type="button"
                  disabled={disabled}
                  onClick={() => onOpen(file.sourceId)}
                >
                  <strong>{file.name}</strong>
                  <small>
                    {[file.mediaType?.split("/").at(-1)?.toUpperCase(), size]
                      .filter(Boolean)
                      .join(" · ") ||
                      file.provenance ||
                      "Shared file"}
                  </small>
                </button>
              ) : (
                <span>
                  <strong>{file.name}</strong>
                  <small>
                    {[file.mediaType?.split("/").at(-1)?.toUpperCase(), size]
                      .filter(Boolean)
                      .join(" · ") ||
                      file.provenance ||
                      "Shared file"}
                  </small>
                </span>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(file.sourceId)}
                aria-label={`Remove ${file.name} from project`}
              >
                <Trash size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {files.length === 0 ? (
          <p className="project-files__empty">
            No files have been added to this project.
          </p>
        ) : null}
      </div>
    </section>
  );
}
