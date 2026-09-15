import { lazy, Suspense, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useLocalComputer } from "../../hooks/useLocalComputer";
import { safeConversationLink } from "../../lib/safe-output";
import {
  getRuntimeAdapter,
  hasNativeRuntimeAdapter,
} from "../../runtime/adapters/select";

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
  onClose,
}: {
  output: string;
  workspaceId: string;
  agentId: string;
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
      />
    </Suspense>
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
