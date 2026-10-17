import { useCallback, useEffect, useRef, useState } from "react";
import { extractGeneratedHtml } from "../../../lib/generated-html";
import { conversationUi } from "../../../runtime/domains/conversation-ui";
import { MessageMarkdown } from "../MessageMarkdown";
import "./generated-html.css";

type Resource = { resourceId: string; url: string };
export default function GeneratedHtmlResponse({
  text,
  source,
  streaming,
  workspaceId,
  conversationId,
  agentId,
  runId,
}: {
  text: string;
  source?: string;
  streaming: boolean;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  runId: string;
}) {
  const extracted = extractGeneratedHtml(text);
  const [resource, setResource] = useState<Resource>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [frameLoaded, setFrameLoaded] = useState(false);
  const live = useRef<Resource | undefined>(undefined);
  const preview = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  const openingTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const owner = { workspaceId, conversationId, agentId };
  const release = useCallback(
    (value: Resource) => {
      void conversationUi(
        { workspaceId, conversationId, agentId },
        {
          action: "close-html",
          runId,
          resourceId: value.resourceId,
        },
      ).catch(() => {});
    },
    [workspaceId, conversationId, agentId, runId],
  );
  useEffect(() => {
    ++epoch.current;
    setResource(undefined);
    setOpening(false);
    setError("");
    setFrameLoaded(false);
    return () => {
      ++epoch.current;
      clearTimeout(openingTimeout.current);
      if (live.current) release(live.current);
      live.current = undefined;
    };
    // The cleanup must retain the owner of the resource being torn down.
  }, [release, source, streaming]);
  const open = async () => {
    if (
      !extracted ||
      opening ||
      streaming ||
      !source ||
      !extracted.complete ||
      extracted.error
    )
      return;
    const version = epoch.current;
    setOpening(true);
    setError("");
    setFrameLoaded(false);
    const timeout = setTimeout(() => {
      if (version !== epoch.current) return;
      ++epoch.current;
      setOpening(false);
      setError("The preview took too long to open. Try again; a late preview will be closed automatically.");
    }, 20_000);
    openingTimeout.current = timeout;
    try {
      const result = await conversationUi<Resource>(owner, {
        action: "render-html",
        runId,
        source,
      });
      // Never frame a caller-supplied/native-bridge URL, even if transport is mocked.
      const issued = /^http:\/\/127\.0\.0\.2:\d+\/([a-f0-9]{64})\/index\.html$/.exec(result.url);
      if (!issued || issued[1] !== result.resourceId) {
        release(result);
        throw new Error("The isolated preview origin is unavailable.");
      }
      if (version !== epoch.current) {
        release(result);
        return;
      }
      live.current = result;
      setResource(result);
    } catch (reason) {
      if (version === epoch.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      clearTimeout(timeout);
      if (version === epoch.current) setOpening(false);
    }
  };
  const close = () => {
    ++epoch.current;
    if (live.current) release(live.current);
    live.current = undefined;
    setResource(undefined);
    setOpening(false);
    setFrameLoaded(false);
  };
  useEffect(() => {
    if (!resource || frameLoaded) return;
    const timeout = setTimeout(() => {
      ++epoch.current;
      release(resource);
      live.current = undefined;
      setResource(undefined);
      setOpening(false);
      setError("The isolated preview did not finish loading. Try opening it again.");
    }, 20_000);
    return () => clearTimeout(timeout);
  }, [resource, frameLoaded, release]);
  useEffect(() => {
    if (!resource) return;
    const stop = () => {
      ++epoch.current;
      release(resource);
      live.current = undefined;
      setResource(undefined);
      setOpening(false);
    };
    // Resource expiry must also remove the executable guest, rather than only
    // refusing subsequent HTTP reads. Hidden compact panes must not keep it running.
    const timeout = setTimeout(stop, 15 * 60 * 1000);
    const dock = preview.current?.closest(".conversation-dock");
    if (dock?.hasAttribute("hidden")) stop();
    const observer = dock
      ? new MutationObserver(() => {
          if (dock.hasAttribute("hidden")) stop();
        })
      : undefined;
    if (dock)
      observer?.observe(dock, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    return () => {
      clearTimeout(timeout);
      observer?.disconnect();
    };
  }, [resource, release]);
  if (!extracted) return <MessageMarkdown content={text} />;
  return (
    <div className="generated-html-response">
      <MessageMarkdown content={extracted.before} />
      <section
        ref={preview}
        className="generated-html-preview"
        aria-label="Custom interactive response"
      >
        <div className="generated-html-toolbar">
          <span>Interactive preview</span>
          {resource ? (
            <button onClick={close}>Close preview</button>
          ) : (
            <button
              disabled={
                opening ||
                streaming ||
                !source ||
                !extracted.complete ||
                !!extracted.error
              }
              onClick={() => void open()}
            >
              {opening ? "Opening…" : error ? "Retry preview" : "Open preview"}
            </button>
          )}
        </div>
        {resource && (
          <iframe
            title="Custom interactive response"
            src={resource.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
            onLoad={() => setFrameLoaded(true)}
          />
        )}
        {resource && !frameLoaded && <p role="status">Loading isolated preview…</p>}
        <p className="generated-html-note">
          Runs locally. No network or tool access. Closes after 15 minutes.
          Changes reset when closed.
        </p>
        {(error || extracted.error) && (
          <p role="status">{error || extracted.error}</p>
        )}
        {streaming && (
          <p role="status">
            Wait for the complete response to open this preview.
          </p>
        )}
        <details>
          <summary>View HTML source</summary>
          <pre>{extracted.html}</pre>
        </details>
      </section>
      <MessageMarkdown content={extracted.after} />
    </div>
  );
}
