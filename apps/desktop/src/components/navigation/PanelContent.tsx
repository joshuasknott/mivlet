import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useLocalComputer } from "../../hooks/useLocalComputer";
import { safeConversationLink } from "../../lib/safe-output";
import {
  getRuntimeAdapter,
  hasNativeRuntimeAdapter,
} from "../../runtime/adapters/select";
import { getRuntimeOutput } from "../../runtime/domains/outputs";
import type { OutputDocument } from "../../lib/output-revisions";
import type { OutputSource } from "../../lib/output-revisions";
import { subscribeOutputRevisionApplied } from "../../lib/output-revision-events";
import { OutputEditor } from "../conversation/OutputEditor";

export { OpenWebPreview } from "./open-web-preview";

const ArtifactPreview = lazy(() =>
  import("../conversation/ArtifactPreview").then((module) => ({
    default: module.ArtifactPreview,
  })),
);

export function PanelArtifact({
  output,
  workspaceId,
  agentId,
  conversationId,
  messageId,
  sourceRevisionId,
  onClose,
}: {
  output: string;
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  messageId?: string;
  sourceRevisionId?: string;
  onClose: () => void;
}) {
  const computer = useLocalComputer({
    workspaceId,
    agentId,
    executionOwner: false,
  });
  if (computer.loading)
    return (
      <p className="right-panel__empty" role="status">
        Loading your file…
      </p>
    );
  return (
    <Suspense
      fallback={
        <p className="right-panel__empty" role="status">
          Loading your file…
        </p>
      }
    >
      <ArtifactPreview
        output={output}
        workspaceId={workspaceId}
        agentId={agentId}
        generation={computer.node?.generation}
        onClose={onClose}
        embedded
        conversationId={conversationId}
        messageId={messageId}
        sourceRevisionId={sourceRevisionId}
      />
    </Suspense>
  );
}

export function PanelOutput({
  outputId,
  workspaceId,
  onClose,
  onOpenConversation,
}: {
  outputId: string;
  workspaceId: string;
  onClose: () => void;
  onOpenConversation?: (conversationId: string, source: OutputSource) => void;
}) {
  const [output, setOutput] = useState<OutputDocument | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    // Do not leave the previous tab visible while a newly selected output is
    // being reloaded. A stale editor can otherwise look like the requested
    // output and invite edits against the wrong durable identity.
    setOutput(null);
    setError("");
    void getRuntimeOutput(outputId, workspaceId)
      .then((value) => {
        if (!active) return;
        if (!value) {
          setError("This saved output is no longer available.");
          return;
        }
        setOutput(value);
      })
      .catch((failure: unknown) => {
        if (active) {
          setOutput(null);
          setError(
            failure instanceof Error
              ? failure.message
              : "This saved output could not be opened.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [outputId, workspaceId]);
  useEffect(() => {
    if (!output) return;
    return subscribeOutputRevisionApplied((event) => {
      if (
        event.outputId === output.id &&
        event.conversationId === output.source.conversationId
      ) {
        // OutputEditor owns the local draft/CAS conflict decision. Updating
        // the durable snapshot here lets a clean panel follow an agent
        // revision while a dirty panel preserves its draft and shows reload.
        setOutput(event.output);
      }
    });
  }, [output]);
  if (error) return <p role="alert">{error}</p>;
  if (!output) return <p role="status">Loading saved output…</p>;
  const origin = output.pin?.source ?? output.source;
  const pinnedRevision = output.pin?.revisionId
    ? output.revisions.find((revision) => revision.id === output.pin?.revisionId)
    : undefined;
  const editorSource = pinnedRevision?.provenance ?? output.source;
  return (
    <section
      className="right-panel__output"
      aria-label={`${output.title} output`}
    >
      <header>
        <div>
          <h2>{output.title}</h2>
          <p>Saved output · revision {output.currentRevisionNumber}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close saved output">
          ×
        </button>
      </header>
      {onOpenConversation ? (
        <button
          type="button"
          className="right-panel__output-source"
          onClick={() => {
            onOpenConversation(origin.conversationId, origin);
          }}
        >
          Open originating conversation
        </button>
      ) : null}
      <details className="right-panel__output-source-details">
        <summary>Source details</summary>
        <p>
          Conversation: {origin.conversationId}
          {origin.messageId ? ` · message ${origin.messageId}` : ""}
          {origin.sourceRevisionId
            ? ` · message revision ${origin.sourceRevisionId}`
            : ""}
          {origin.branchId ? ` · branch ${origin.branchId}` : ""}
        </p>
      </details>
      <OutputEditor
        output={output}
        source={editorSource}
        workspaceId={workspaceId}
        onChange={setOutput}
      />
    </section>
  );
}

/** Remote pages get no scripts, storage origin, forms, popups, downloads or native IPC. */
export function PanelWebPreview({ url }: { url: string }) {
  const safe = safeConversationLink(url);
  const [error, setError] = useState("");
  if (!safe) return <p role="alert">This link cannot be previewed.</p>;
  return (
    <div className="right-panel__web">
      <header>
        <span title={safe}>{new URL(safe).hostname}</span>
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open in browser"
          title="Open in browser"
          onClick={(event) => {
            if (!hasNativeRuntimeAdapter()) return;
            event.preventDefault();
            setError("");
            void getRuntimeAdapter()
              .invoke<void>("open_conversation_link", { url: safe })
              .catch(() =>
                setError(
                  "Could not open your browser. Copy the link address to open it.",
                ),
              );
          }}
        >
          <ArrowSquareOut size={18} />
        </a>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <p className="right-panel__web-notice">
        Some sites block previews or need an interactive browser.{" "}
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!hasNativeRuntimeAdapter()) return;
            event.preventDefault();
            void getRuntimeAdapter()
              .invoke<void>("open_conversation_link", { url: safe })
              .catch(() =>
                setError(
                  "Could not open your browser. Copy the link address to open it.",
                ),
              );
          }}
        >
          Open in browser
        </a>
      </p>
      {safe.startsWith("https:") ? (
        <iframe
          key={safe}
          src={safe}
          title={`Web preview: ${new URL(safe).hostname}`}
          sandbox=""
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className="right-panel__empty">
          This address opens in your browser.
        </p>
      )}
    </div>
  );
}
