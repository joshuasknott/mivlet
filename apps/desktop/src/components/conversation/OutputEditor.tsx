import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { OutputDocument, OutputSource, OutputRevisionRequest } from "../../lib/output-revisions";
import {
  appendRuntimeOutputRevision,
  exportRuntimeOutput,
  getRuntimeOutput,
  restoreRuntimeOutputRevision,
  setRuntimeOutputPinned,
} from "../../runtime/domains/outputs";
import "./output-editor.css";
import { conversationUi } from "../../runtime/domains/conversation-ui";
import { emitOutputRevisionRequest, requestOutputSelection } from "../../lib/output-revision-events";

const OutputCsvEditor = lazy(() =>
  import("./OutputCsvEditor").then(({ OutputCsvEditor: component }) => ({ default: component })),
);

function isConflict(failure: unknown) {
  const message = failure instanceof Error ? failure.message.toLowerCase() : "";
  return (
    message.includes("changed in another pane") ||
    message.includes("newer revision") ||
    message.includes("stale")
  );
}

function snapshot(output: OutputDocument) {
  const revision = current(output);
  return { id: revision.id, number: revision.number, content: revision.content };
}

function current(output: OutputDocument) {
  return (
    output.revisions.find(
      (revision) => revision.id === output.currentRevisionId,
    ) ?? output.revisions.at(-1)!
  );
}

export function OutputEditor({
  output,
  source,
  workspaceId,
  onChange,
  onRequestRevision,
}: {
  output: OutputDocument;
  source: OutputSource;
  workspaceId: string;
  onChange: (output: OutputDocument) => void;
  onRequestRevision?: (request: OutputRevisionRequest) => void;
}) {
  const revision = current(output);
  const [draft, setDraft] = useState(revision.content);
  const [draftBase, setDraftBase] = useState({
    id: output.currentRevisionId,
    number: output.currentRevisionNumber,
  });
  const [baseContent, setBaseContent] = useState(revision.content);
  const [state, setState] = useState<
    "saved" | "unsaved" | "saving" | "exporting" | "exported" | "error"
  >(
    "saved",
  );
  const [error, setError] = useState("");
  const [exportDestination, setExportDestination] = useState("");
  const [conflict, setConflict] = useState(false);
  const [selection, setSelection] = useState("");
  const [selectionReference, setSelectionReference] = useState("");
  const [compare, setCompare] = useState<number | null>(null);
  const [selected, setSelected] = useState(revision.number);
  const dirty = draft !== baseContent || state === "saving";
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const lastOutputRevision = useRef(snapshot(output));
  const adopt = (next: OutputDocument) => {
    const nextRevision = current(next);
    onChange(next);
    setDraft(nextRevision.content);
    setBaseContent(nextRevision.content);
    setDraftBase({ id: next.currentRevisionId, number: next.currentRevisionNumber });
    setSelected(next.currentRevisionNumber);
    lastOutputRevision.current = snapshot(next);
    setState("saved");
  };

  // A second pane or an agent may refresh this component while the user is
  // typing. Preserve that local draft and keep its original CAS base so the
  // native repository rejects an unsafe overwrite instead of silently
  // replacing newer work.
  useEffect(() => {
    const incoming = snapshot(output);
    const previous = lastOutputRevision.current;
    if (
      previous.id === incoming.id &&
      previous.number === incoming.number &&
      previous.content === incoming.content
    ) return;
    lastOutputRevision.current = incoming;
    if (dirtyRef.current) {
      setConflict(true);
      setState("error");
      setError(
        "A newer revision arrived in another pane. Your draft is preserved; reload it or save after reviewing the conflict.",
      );
      return;
    }
    const next = current(output);
    setDraft(next.content);
    setBaseContent(next.content);
    setDraftBase({
      id: output.currentRevisionId,
      number: output.currentRevisionNumber,
    });
    setSelected(next.number);
    setError("");
    setExportDestination("");
    setState("saved");
  }, [output]);
  const supportsGenericRevision =
    output.format === "text" ||
    output.format === "markdown" ||
    output.format === "json" ||
    output.format === "csv";
  const isStructured = !supportsGenericRevision;
  const selectedRevision = useMemo(
    () => output.revisions.find((item) => item.number === selected) ?? revision,
    [output.revisions, selected, revision],
  );
  const pinnedRevision = output.pin
    ? output.revisions.find((item) => item.id === output.pin?.revisionId)
    : undefined;
  const [csvCell, setCsvCell] = useState<{ row: number; column: number } | null>(null);
  const focusCsvCell = (row: number, column: number, value: string) => {
    setCsvCell({ row, column });
    setSelection(value);
    setSelectionReference(`CSV cell R${row + 1}C${column + 1}`);
  };
  const changeCsvCell = (content: string, row: number, column: number, value: string) => {
    setDraft(content);
    setCsvCell({ row, column });
    setSelection(value);
    setSelectionReference(`CSV cell R${row + 1}C${column + 1}`);
    setExportDestination("");
    setState("unsaved");
  };

  const reportFailure = (failure: unknown, fallback: string) => {
    setState("error");
    if (isConflict(failure)) setConflict(true);
    setError(failure instanceof Error ? failure.message : fallback);
  };

  const save = async () => {
    if (!supportsGenericRevision) {
      setState("error");
      setError("Edit this file using its format-specific native editor.");
      return;
    }
    setState("saving");
    setError("");
    setExportDestination("");
    setConflict(false);
    try {
      const next = await appendRuntimeOutputRevision(
        {
          outputId: output.id,
          expectedRevisionId: draftBase.id,
          expectedRevisionNumber: draftBase.number,
          content: draft,
          author: "user",
          provenance: { ...source, reason: "direct-edit" },
        },
        workspaceId,
      );
      adopt(next);
    } catch (failure) {
      reportFailure(failure, "Could not save this output.");
    }
  };

  const restore = async () => {
    setState("saving");
    setError("");
    setExportDestination("");
    try {
      const next = await restoreRuntimeOutputRevision(
        output.id,
        selectedRevision.number,
        output.currentRevisionId,
        output.currentRevisionNumber,
        source,
        workspaceId,
      );
      adopt(next);
    } catch (failure) {
      reportFailure(failure, "Could not restore this revision.");
    }
  };

  const pin = async () => {
    try {
      onChange(
        await setRuntimeOutputPinned(
          output.id,
          !output.pinned,
          source,
          workspaceId,
          selectedRevision.id,
        ),
      );
      setConflict(false);
    } catch (failure) {
      reportFailure(failure, "Could not update the pinned output.");
    }
  };

  const exportOutput = async () => {
    if (state === "exporting") return;
    setState("exporting");
    setError("");
    setExportDestination("");
    try {
      const destination = await exportRuntimeOutput(
        output.id,
        undefined,
        workspaceId,
      );
      setExportDestination(destination);
      setState("exported");
    } catch (failure) {
      reportFailure(failure, "Could not export this output.");
    }
  };

  const selectionAction = async (intent: "quote" | "explain" | "memory") => {
    if (dirty || !selection || !source.agentId) return;
    try {
      const passage = await conversationUi<{ selection: string; reference: string }>(
        { workspaceId, conversationId: source.conversationId, agentId: source.agentId },
        { action: "quote-output", outputId: output.id, revisionId: draftBase.id, selection },
      );
      const reference = selectionReference
        ? `${passage.reference} · ${selectionReference}`
        : passage.reference;
      await requestOutputSelection(source.conversationId, intent, passage.selection, reference);
      setError("");
      if (intent !== "memory") setSelection("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The selected passage is unavailable."); }
  };
  const reloadLatest = async () => {
    setState("saving");
    setError("");
    try {
      const latest = await getRuntimeOutput(output.id, workspaceId);
      if (!latest) throw new Error("The saved output is no longer available.");
      adopt(latest);
      setConflict(false);
      setExportDestination("");
    } catch (failure) {
      reportFailure(failure, "The latest output could not be loaded.");
    }
  };
  const requestRevision = () => {
    if (!supportsGenericRevision) {
      setState("error");
      setError("Edit this file using its format-specific native editor.");
      return;
    }
    const request: OutputRevisionRequest = {
      outputId: output.id,
      expectedRevisionId: draftBase.id,
      expectedRevisionNumber: draftBase.number,
      content: draft,
      selection: selectionReference ? `${selectionReference}: ${selection}` : selection,
      source,
    };
    if (onRequestRevision) {
      onRequestRevision(request);
      return;
    }
    if (!emitOutputRevisionRequest({ kind: "text", conversationId: source.conversationId, request })) {
      setError("Open the originating conversation beside this output before requesting a revision.");
    }
  };

  return (
    <section className="output-editor" aria-label={`${output.title} editor`}>
      <div className="output-editor__toolbar">
        <span className="output-editor__format">
          {output.format} · editing current revision {output.currentRevisionNumber}
        </span>
        {output.pinned && pinnedRevision ? (
          <span className="output-editor__pin-status" role="status">
            Pinned revision {pinnedRevision.number}
          </span>
        ) : null}
        <span className="output-editor__state" data-state={state} role="status">
          {state === "unsaved"
            ? "Unsaved changes"
            : state === "saving"
              ? "Saving…"
              : state === "exporting"
                ? "Exporting…"
                : state === "exported"
                  ? "Exported"
              : state === "error"
                ? "Save error"
                : "Saved"}
        </span>
        {exportDestination ? (
          <span className="output-editor__export-destination" role="status">
            Exported to {exportDestination}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void pin()}
          aria-pressed={output.pinned}
        >
          {output.pinned ? "Unpin revision" : `Pin revision ${selectedRevision.number}`}
        </button>
        <button
          type="button"
          disabled={dirty || state === "exporting"}
          onClick={() => void exportOutput()}
        >
          {state === "exporting" ? "Exporting…" : "Export"}
        </button>
      </div>
      {output.pinned && pinnedRevision && pinnedRevision.id !== output.currentRevisionId ? (
        <section className="output-editor__pinned-preview" aria-label={`Pinned revision ${pinnedRevision.number}`}>
          <h3>Pinned revision {pinnedRevision.number}</h3>
          <p>Pinned history stays unchanged. New edits apply to the current revision.</p>
          <pre tabIndex={0}>{pinnedRevision.content}</pre>
        </section>
      ) : null}
      {isStructured ? (
        <p className="output-editor__notice">
          {output.format === "document" || output.format === "spreadsheet" || output.format === "presentation"
            ? `This ${output.format} keeps its native structure and formulas. Edit in its native app; saved revisions remain here.`
            : `Use the ${output.format} editor. This preview retains the saved revision.`}
        </p>
      ) : null}
      {output.format === "csv" ? (
        <Suspense fallback={<p role="status">Loading CSV editor…</p>}>
          <OutputCsvEditor
            content={draft}
            selectedCell={csvCell}
            onCellFocus={focusCsvCell}
            onCellChange={changeCsvCell}
            onError={(message) => {
              setError(message);
              setState("error");
            }}
          />
        </Suspense>
      ) : (
        <textarea
          value={draft}
          readOnly={isStructured}
          aria-label={`${output.title} content`}
          onChange={(event) => {
            setDraft(event.target.value);
            setExportDestination("");
            setState("unsaved");
          }}
          onSelect={(event) => {
            const target = event.currentTarget;
            setSelection(
              target.value
                .slice(target.selectionStart, target.selectionEnd)
                .trim(),
            );
          }}
        />
      )}
      <div className="output-editor__actions">
        {selection && !dirty && source.agentId ? <div role="toolbar" aria-label="Selected output actions">
          <button type="button" onClick={() => void selectionAction("quote")}>Quote / ask</button>
          <button type="button" onClick={() => void selectionAction("explain")}>Explain</button>
          <button type="button" onClick={() => void selectionAction("memory")}>Save to memory</button>
        </div> : null}
        <button
          type="button"
          disabled={state !== "unsaved" || isStructured}
          onClick={() => void save()}
        >
          Save revision
        </button>
        <button
          type="button"
          disabled={dirty || isStructured}
          onClick={requestRevision}
        >
          {selection ? "Revise selection" : "Request agent revision"}
        </button>
      </div>
      {conflict ? (
        <button
          type="button"
          onClick={() => void reloadLatest()}
          disabled={state === "saving"}
        >
          Reload latest revision
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="output-editor__error">
          {error}
        </p>
      ) : null}
      <details className="output-editor__history">
        <summary>Revision history ({output.revisions.length})</summary>
        <label>
          Compare or restore{" "}
          <select
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {output.revisions.map((item) => (
              <option key={item.id} value={item.number}>
                Revision {item.number} · {item.author}{item.provenance.reason === "restore" ? " · restored" : ""}{output.pin?.revisionId === item.id ? " · pinned" : ""}
              </option>
            ))}
          </select>
        </label>
        {selectedRevision.number !== output.currentRevisionNumber ? (
          <>
            <pre>{selectedRevision.content}</pre>
            <div className="output-editor__actions">
              <button
                type="button"
                onClick={() =>
                  setCompare(
                    compare === selectedRevision.number
                      ? null
                      : selectedRevision.number,
                  )
                }
              >
                {compare === selectedRevision.number
                  ? "Hide comparison"
                  : "Compare with current"}
              </button>
              <button type="button" disabled={dirty} onClick={() => void restore()}>
                Restore as new revision
              </button>
            </div>
            {compare === selectedRevision.number ? (
              <div className="output-editor__comparison" role="region" aria-label="Revision comparison">
                <div><strong>Revision {selectedRevision.number} · {selectedRevision.author}</strong><pre>{selectedRevision.content}</pre></div>
                <div><strong>Current revision {revision.number} · {revision.author}</strong><pre>{revision.content}</pre></div>
              </div>
            ) : null}
          </>
        ) : null}
      </details>
    </section>
  );
}
