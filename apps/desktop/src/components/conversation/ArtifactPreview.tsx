import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { LocalComputerArtifactPreview } from "@mivlet/protocol";
import {
  parseComputerArtifact,
  previewComputerArtifact,
} from "../../lib/computer-artifacts";
import type { OutputDocument, OutputFormat } from "../../lib/output-revisions";
import {
  ensureRuntimeOutput,
} from "../../runtime/domains/outputs";
import { ComputerArtifacts } from "../ComputerArtifacts";
import { MessageMarkdown } from "./MessageMarkdown";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { type OfficeCellSelection } from "./OfficePreview";
import { OfficeOutputEditor } from "./OfficeOutputEditor";
import { OutputEditor } from "./OutputEditor";
import type { OutputRevisionRequest } from "../../lib/output-revisions";
import {
  emitOutputRevisionRequest,
  subscribeOutputRevisionApplied,
} from "../../lib/output-revision-events";
const PdfPreview = lazy(() =>
  import("./PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

export function ArtifactPreview({
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
    if (!conversationId) return;
    return subscribeOutputRevisionApplied((event) => {
      if (event.conversationId !== conversationId) return;
      if (outputDocument && event.outputId === outputDocument.id)
        setOutputDocument(event.output);
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
    if (!conversationId || !preview?.text || !artifact) return;
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
      setOutputDocument(document);
      setEditing(true);
    } catch (failure) {
      setEditError(
        failure instanceof Error
          ? failure.message
          : "This output could not be opened for editing.",
      );
    }
  };
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
              <MessageMarkdown content={preview.text} />
            ) : (
              <pre tabIndex={0}>{preview.text || "This file is empty."}</pre>
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
            onClick={() => void beginEditing()}
          >
            Edit output
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
