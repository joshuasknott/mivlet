import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { GeneratedInterfaceState } from "@mivlet/protocol";
import {
  extractGeneratedInterface,
  validateGeneratedInterface,
} from "../../../lib/generated-interface";
import { conversationUi } from "../../../runtime/domains/conversation-ui";
import { MessageMarkdown } from "../MessageMarkdown";
import "./generated.css";
import { extractGeneratedHtml } from "../../../lib/generated-html";

// @openuidev/react-lang auto-mounts its development inspector when the package
// is evaluated. Mivlet deliberately keeps observability opt-in and publishes no
// transcript content to that inspector, so set the package's supported global
// guard before the lazy renderer is evaluated.
const openUiFlags = globalThis as typeof globalThis & {
  [key: symbol]: unknown;
};
openUiFlags[Symbol.for("openui.devtools.autoMount")] = true;

const InterfaceRenderer = lazy(() => import("./InterfaceRenderer"));
const GeneratedHtmlResponse = lazy(() => import("./GeneratedHtmlResponse"));
/** Renderer waits are bounded; native writes may still complete and must be
 * reconciled by reloading rather than automatically replaying an action. */
function awaitSavedInterface<T>(request: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Saved answers did not respond in time. Reload to check the saved state; a pending change may still finish.")), 20_000);
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timeout));
}
export function GeneratedResponse({
  text,
  streaming,
  workspaceId,
  conversationId,
  runId,
  agentId,
  generation,
  source,
  responseRevisionId,
  onDraft,
}: {
  text: string;
  streaming: boolean;
  workspaceId: string;
  conversationId: string;
  runId: string;
  agentId: string;
  generation?: number;
  /** Exact terminal assistant revision content persisted by native Mivlet. */
  source?: string;
  /** Stable revision identity used to reset restored interface state. */
  responseRevisionId?: string;
  onDraft: (text: string) => void;
}) {
  const interactionSource = source ?? text;
  const extracted = useMemo(() => extractGeneratedInterface(text), [text]);
  const checked = useMemo(
    () =>
      extracted
        ? validateGeneratedInterface(
            extracted.code,
            streaming,
            extracted.profile,
          )
        : null,
    [extracted, streaming],
  );
  const [saved, setSaved] = useState<GeneratedInterfaceState>();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [status, setStatus] = useState("Loading saved answers…");
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [reload, setReload] = useState(0);
  const latest = useRef({ saved, values });
  latest.current = { saved, values };
  const epoch = useRef(0);
  const pending = useRef(Promise.resolve());
  const reviewing = useRef(false);
  const scope = `${workspaceId}:${conversationId}:${runId}:${agentId}:${generation ?? 0}:${responseRevisionId ?? ""}:${interactionSource}`;
  useEffect(() => {
    const version = ++epoch.current;
    reviewing.current = false;
    pending.current = Promise.resolve();
    setSaved(undefined);
    setValues({});
    setError("");
    setRenderError("");
    setStatus("Loading saved answers…");
    if (!streaming && extracted && !extracted.complete) {
      setStatus(
        "Incomplete response; controls are unavailable. Ask the agent to finish it.",
      );
      return;
    }
    if (checked?.error) {
      setStatus(
        "Controls are unavailable. Ask the agent to revise this response.",
      );
      return;
    }
    if (!source || !responseRevisionId) {
      setStatus(
        "Waiting for this response to be saved before enabling controls…",
      );
      return;
    }
    if (streaming || !extracted?.complete || checked?.error) return;
    void awaitSavedInterface(conversationUi<GeneratedInterfaceState>(
      { workspaceId, conversationId, agentId },
      { action: "load-interface", runId, source: interactionSource },
    ))
      .then((result) => {
        if (version !== epoch.current) return;
        latest.current = { saved: result, values: result.values };
        setSaved(result);
        setValues(result.values);
        setStatus("Saved on this device");
      })
      .catch((reason) => {
        if (version === epoch.current) {
          setError(String(reason instanceof Error ? reason.message : reason));
          setStatus("Answers unavailable");
        }
      });
    return () => {
      epoch.current++;
    };
  }, [scope, streaming, extracted?.complete, checked?.error, reload]);
  if (!extracted) {
    if (extractGeneratedHtml(text))
      return (
        <Suspense fallback={<p role="status">Loading preview controls…</p>}>
          <GeneratedHtmlResponse
            key={`${workspaceId}:${conversationId}:${runId}:${agentId}:${generation ?? 0}:${responseRevisionId ?? ""}`}
            text={text}
            source={source}
            streaming={streaming}
            workspaceId={workspaceId}
            conversationId={conversationId}
            agentId={agentId}
            runId={runId}
          />
        </Suspense>
      );
    return <MessageMarkdown content={text} />;
  }
  const change = (key: string, value: string | boolean) => {
    if (!latest.current.saved || streaming || reviewing.current) return;
    const version = epoch.current;
    const next = { ...latest.current.values, [key]: value };
    latest.current.values = next;
    setValues(next);
    setStatus("Saving…");
    pending.current = pending.current
      .then(async () => {
        if (version !== epoch.current || !latest.current.saved) return;
        const result = await awaitSavedInterface(conversationUi<GeneratedInterfaceState>(
          { workspaceId, conversationId, agentId },
          {
            action: "save-interface",
            runId,
            source: interactionSource,
            expectedRevision: latest.current.saved.revision,
            values: next,
          },
        ));
        if (version !== epoch.current) return;
        latest.current.saved = result;
        setSaved(result);
        setStatus("Saved on this device");
        setError("");
      })
      .catch((reason) => {
        if (version === epoch.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setStatus("Not saved");
          setSaved(undefined);
          latest.current.saved = undefined;
        }
      });
  };
  const review = (label: string) => {
    if (reviewing.current || streaming || !latest.current.saved) return;
    reviewing.current = true;
    const version = epoch.current;
    void pending.current
      .then(async () => {
        if (version !== epoch.current || !latest.current.saved) return;
        const result = await awaitSavedInterface(conversationUi<{
          state: GeneratedInterfaceState;
          draft: string;
        }>(
          { workspaceId, conversationId, agentId },
          {
            action: "review-interface",
            runId,
            source: interactionSource,
            expectedRevision: latest.current.saved.revision,
            eventId: crypto.randomUUID(),
            label,
          },
        ));
        if (version !== epoch.current) return;
        latest.current.saved = result.state;
        setSaved(result.state);
        onDraft(result.draft);
        setStatus("Reply ready to review in composer");
      })
      .catch((reason) => {
        if (version === epoch.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setStatus("Reply unavailable. Reload saved answers before trying again.");
          setSaved(undefined);
          latest.current.saved = undefined;
        }
      })
      .finally(() => {
        if (version === epoch.current) reviewing.current = false;
      });
  };
  return (
    <>
      {extracted.before.trim() ? (
        <MessageMarkdown content={extracted.before} />
      ) : null}
      <section
        className="generated-interface"
        aria-label="Interactive response"
        aria-busy={streaming}
      >
        {checked?.error ? (
          <p role="alert">
            {checked.error} The original response is available below.
          </p>
        ) : checked?.code ? (
          <Suspense
            fallback={<p role="status">Loading interactive response…</p>}
          >
            <InterfaceRenderer
              key={
                extracted.profile
                  ? `${responseRevisionId ?? "pending"}:${saved?.sourceRevision ?? "loading"}`
                  : "legacy"
              }
              code={checked.code}
              profile={extracted.profile}
              owner={{ workspaceId, agentId, generation }}
              onError={setRenderError}
              streaming={streaming}
              interaction={{
                state: values,
                disabled: streaming || !saved,
                change,
                review,
              }}
            />
          </Suspense>
        ) : (
          <p role="status">Preparing interactive response…</p>
        )}
        <small role="status">
          {streaming
            ? "Generating… controls become available when this response is saved."
            : renderError ? "Controls unavailable; repair this response to continue." : status}
        </small>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              type="button"
              disabled={streaming}
              onClick={() => setReload((value) => value + 1)}
            >
              Reload saved answers
            </button>
          </>
        ) : null}
        {!streaming && (checked?.error || renderError || !extracted.complete) ? (
          <button
            type="button"
            disabled={!source || !responseRevisionId}
            onClick={() => onDraft(`Please repair the interactive response in conversation ${conversationId}, run ${runId}, revision ${responseRevisionId}. ${checked?.error || renderError || "The response ended before its interface was complete."} Return one complete, valid openui-v2 block using Mivlet's supported components. Preserve my request and do not perform additional actions.`)}
          >
            Ask agent to repair response
          </button>
        ) : null}
        <details>
          <summary>Inspect interface source</summary>
          <pre>{extracted.code}</pre>
        </details>
      </section>
      {extracted.after.trim() ? (
        <MessageMarkdown content={extracted.after} />
      ) : null}
    </>
  );
}
