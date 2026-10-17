import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from "react";
import type { LocalComputerArtifactPreview } from "@mivlet/protocol";
import {
  parseComputerArtifact,
  previewComputerArtifact,
} from "../../lib/computer-artifacts";
import type { OutputDocument, OutputFormat } from "../../lib/output-revisions";
import {
  ensureRuntimeOutput,
  getRuntimeOutput,
} from "../../runtime/domains/outputs";
import { ComputerArtifacts } from "../ComputerArtifacts";
import { MessageMarkdown } from "./MessageMarkdown";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { type OfficeCellSelection } from "./OfficePreview";
import { OfficeOutputEditor } from "./OfficeOutputEditor";
import { OutputEditor } from "./OutputEditor";
// Shared preview engines load through this existing deferred artifact entry.
export { OutputEditor };
export { OfficePreview } from "./OfficePreview";
import type { OutputRevisionRequest } from "../../lib/output-revisions";
import {
  emitOutputRevisionRequest,
  subscribeOutputRevisionApplied,
} from "../../lib/output-revision-events";
const PdfPreview = lazy(() =>
  import("./PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

// A source change remounts every editor and invalidates pending reads before any
// content from the previous workspace, branch or generation can be displayed.
export function ArtifactPreview(props: ComponentProps<typeof ArtifactPreviewContent>) {
  return <ArtifactPreviewContent key={JSON.stringify([
    props.workspaceId, props.agentId, props.generation, props.conversationId,
    props.messageId, props.branchId, props.sourceRevisionId, props.output,
  ])} {...props} />;
}

function ArtifactPreviewContent({
  output,
  workspaceId,
  agentId,
  generation,
  onClose,
  embedded = false,
  conversationId,
  messageId,
  branchId,
  sourceRevisionId,
  onRequestRevision,
  onRequestOfficeRevision,
}: {
  output: string;
  workspaceId: string;
  agentId: string;
  generation?: number;
  onClose: () => void;
  embedded?: boolean;
  conversationId?: string;
  messageId?: string;
  branchId?: string;
  sourceRevisionId?: string;
  onRequestRevision?: (request: OutputRevisionRequest) => void;
  onRequestOfficeRevision?: (selection: OfficeCellSelection) => void;
}) {
  const artifact = parseComputerArtifact(output);
  const [preview, setPreview] = useState<LocalComputerArtifactPreview | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [outputDocument, setOutputDocument] = useState<OutputDocument | null>(
    null,
  );
  const [editError, setEditError] = useState("");
  const [openingEditor, setOpeningEditor] = useState(false);
  const mounted = useRef(true);
  const outputEpoch = useRef(0);
  const ownsOutput = (document: OutputDocument) => document.source.conversationId === conversationId
    && document.source.artifactId === artifact?.id && document.source.agentId === agentId
    && document.source.branchId === branchId;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({
    active: narrow && !embedded,
    containerRef: panel,
    initialFocusRef: close,
    onClose,
  });
  useEffect(() => {
    if (!embedded) close.current?.focus();
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError("");
    setLoading(true);
    if (!artifact || generation === undefined) {
      setLoading(false);
      setError("Open the computer to preview this file.");
      return;
    }
    void previewComputerArtifact({
      workspaceId,
      agentId,
      artifactId: artifact.id,
      expectedGeneration: generation,
    })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not preview this file.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact?.id, workspaceId, agentId, generation]);
  useEffect(() => {
    if (!artifact || !conversationId) return;
    let cancelled = false;
    const version = outputEpoch.current;
    void getRuntimeOutput(`output-${artifact.id}`, workspaceId).then((document) => {
      if (cancelled || version !== outputEpoch.current || !document) return;
      if (!ownsOutput(document)) {
        setEditError("This saved output belongs to another source. Open its originating conversation to edit it.");
        return;
      }
      setOutputDocument(document);
    }).catch(() => {
      if (!cancelled && version === outputEpoch.current) setEditError("Saved revisions could not be loaded. Choose Edit output to try again.");
    });
    return () => { cancelled = true; };
  }, [artifact?.id, workspaceId, conversationId, agentId, branchId]);
  useEffect(() => {
    if (!conversationId) return;
    return subscribeOutputRevisionApplied((event) => {
      if (event.conversationId !== conversationId) return;
      if (outputDocument && event.outputId === outputDocument.id && ownsOutput(event.output)) {
        ++outputEpoch.current;
        setOutputDocument(event.output);
      }
    });
  }, [conversationId, outputDocument?.id]);
  const format = (mimeType: string): OutputFormat =>
    mimeType === "text/markdown"
      ? "markdown"
      : mimeType === "application/json"
        ? "json"
        : mimeType === "text/csv"
          ? "csv"
          : mimeType === "text/plain"
            ? "text"
            : mimeType === "application/pdf"
              ? "pdf"
              : mimeType.includes("spreadsheet")
                ? "spreadsheet"
                : mimeType.includes("presentation")
                  ? "presentation"
                  : "document";
  const beginEditing = async () => {
    if (!conversationId || preview?.text == null || preview.truncated || !artifact || openingEditor) return;
    setOpeningEditor(true);
    ++outputEpoch.current;
    setEditError("");
    try {
      const outputId = `output-${artifact.id}`;
      const document = await ensureRuntimeOutput(
        {
          id: outputId,
          title: artifact.title,
          format: format(artifact.mimeType),
          mimeType: artifact.mimeType,
          source: {
            conversationId,
            branchId,
            messageId,
            sourceRevisionId,
            artifactId: artifact.id,
            agentId,
          },
          content: preview.text,
          author: "system",
          reason: "generated",
        },
        workspaceId,
      );
      if (!mounted.current) return;
      if (!ownsOutput(document))
        throw new Error("This saved output belongs to another source. Open its originating conversation to edit it.");
      setOutputDocument(document);
      setEditing(true);
    } catch (failure) {
      if (!mounted.current) return;
      setEditError(
        failure instanceof Error
          ? failure.message
          : "This output could not be opened for editing.",
      );
    } finally {
      if (mounted.current) setOpeningEditor(false);
    }
  };
  const savedText = outputDocument?.revisions.find((revision) => revision.id === outputDocument.currentRevisionId)?.content;
  if (!artifact) return null;
  return (
    <aside
      ref={panel}
      className={`artifact-preview${embedded ? " artifact-preview--embedded" : ""}`}
      role={narrow && !embedded ? "dialog" : "complementary"}
      aria-modal={(narrow && !embedded) || undefined}
      aria-label={`${artifact.title} preview`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header>
        <div>
          <h2>{artifact.title}</h2>
        </div>
        <button
          type="button"
          ref={close}
          onClick={onClose}
          aria-label="Close file preview"
        >
          ×
        </button>
      </header>
      <div className="artifact-preview__body">
        {loading ? (
          <p role="status">Loading your file…</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : preview?.pdfBase64 ? (
          <Suspense fallback={<p role="status">Loading PDF preview…</p>}>
            <PdfPreview
              key={artifact.id}
              base64={preview.pdfBase64}
              title={artifact.title}
            />
          </Suspense>
        ) : preview?.office ? (
          <OfficeOutputEditor
            key={artifact.id}
            office={preview.office}
            truncated={preview.truncated}
            workspaceId={workspaceId}
            conversationId={conversationId}
            agentId={agentId}
            artifactId={artifact.id}
            generation={generation}
            title={artifact.title}
            onRequestRevision={
              onRequestOfficeRevision ??
              ((selection) => {
                if (conversationId && !emitOutputRevisionRequest({
                    kind: "office",
                    conversationId,
                    selection,
                  })) {
                  setEditError(
                    "Open the originating conversation beside this output before requesting a revision.",
                  );
                }
              })
            }
          />
        ) : preview?.text !== null && preview?.text !== undefined ? (
          <>
            {editing && outputDocument ? (
              <OutputEditor
                key={outputDocument.id}
                output={outputDocument}
                source={{
                  conversationId: conversationId!,
                  branchId,
                  messageId,
                  sourceRevisionId,
                  artifactId: artifact.id,
                  agentId,
                }}
                workspaceId={workspaceId}
                onChange={setOutputDocument}
                onRequestRevision={
                  onRequestRevision ??
                  ((request) => {
                    if (conversationId && !emitOutputRevisionRequest({
                        kind: "text",
                        conversationId,
                        request,
                      })) setEditError("Open the originating conversation beside this output before requesting a revision.");
                  })
                }
              />
            ) : artifact.mimeType === "text/markdown" ? (
              <MessageMarkdown content={savedText ?? preview.text} />
            ) : (
              <pre tabIndex={0}>{(savedText ?? preview.text) || "This file is empty."}</pre>
            )}
            {preview.truncated ? (
              <p className="turn-notice">
                Showing the first 256 KB. Open the file to see the rest.
              </p>
            ) : null}
          </>
        ) : preview?.imageDataUrl ? (
          <img src={preview.imageDataUrl} alt={artifact.title} />
        ) : (
          <div className="artifact-preview__unsupported">
            <p>This file is ready to open.</p>
            <p>
              Open it in your document or image app to view its full contents.
            </p>
          </div>
        )}
        {preview?.text !== null &&
        preview?.text !== undefined &&
        !preview.truncated &&
        !editing &&
        conversationId ? (
          <button
            type="button"
            className="artifact-preview__edit"
            disabled={openingEditor}
            onClick={() => void beginEditing()}
          >
            {openingEditor ? "Opening editor…" : "Edit output"}
          </button>
        ) : null}
        {editError ? <p role="alert">{editError}</p> : null}
      </div>
      <footer>
        <ComputerArtifacts
          compact
          output={output}
          workspaceId={workspaceId}
          agentId={agentId}
          expectedGeneration={generation}
        />
      </footer>
    </aside>
  );
}
