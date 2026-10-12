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
  const live = useRef<Resource | undefined>(undefined);
  const epoch = useRef(0);
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
    return () => {
      ++epoch.current;
      if (live.current) release(live.current);
      live.current = undefined;
    };
    // The cleanup must retain the owner of the resource being torn down.
  }, [release, source, streaming]);
  if (!extracted) return <MessageMarkdown content={text} />;
  const open = async () => {
    if (
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
    try {
      const result = await conversationUi<Resource>(owner, {
        action: "render-html",
        runId,
        source,
      });
      // Never frame a caller-supplied/native-bridge URL, even if transport is mocked.
      if (
        !/^http:\/\/127\.0\.0\.2:\d+\/[a-f0-9]{64}\/index\.html$/.test(
          result.url,
        )
      ) {
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
      if (version === epoch.current) setOpening(false);
    }
  };
  const close = () => {
    ++epoch.current;
    if (live.current) release(live.current);
    live.current = undefined;
    setResource(undefined);
    setOpening(false);
  };
  return (
    <div className="generated-html-response">
      <MessageMarkdown content={extracted.before} />
      <section
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
              {opening ? "Opening…" : "Open preview"}
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
          />
        )}
        <p className="generated-html-note">
          Runs locally. No network or tool access. Changes reset when closed.
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
