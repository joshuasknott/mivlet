import { useEffect, useRef, useState } from "react";
import {
  backgroundWorkerStatus,
  controlBackgroundWorker,
  type BackgroundWorkerStatus,
} from "../../runtime/domains/background-worker";

export function BackgroundExecutionSettings() {
  const [status, setStatus] = useState<BackgroundWorkerStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void backgroundWorkerStatus()
      .then((value) => {
        if (current === generation.current) setStatus(value);
      })
      .catch((reason: unknown) => {
        if (current === generation.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      generation.current++;
    };
  }, []);
  async function act(action: "start" | "stop" | "restart" | "refresh") {
    const current = ++generation.current;
    setPending(true);
    setError(null);
    try {
      const value =
        action === "refresh"
          ? await backgroundWorkerStatus()
          : await controlBackgroundWorker(action);
      if (current === generation.current) setStatus(value);
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current === generation.current) setPending(false);
    }
  }
  return (
    <section
      className="settings-group"
      aria-labelledby="background-execution-heading"
    >
      <h2 id="background-execution-heading">Background execution</h2>
      <div className="settings-group__surface">
        <div className="settings-preference-row">
          <span>
            <strong>
              Keep supported text work running when you close Mivlet
            </strong>
            <small>
              New text requests and Read Only agent schedules using Codex,
              Claude or supported direct APIs can continue while Windows is
              awake and your account session is valid. Results and Stop stay in
              the conversation.
            </small>
            <small>
              Requests with files, connected apps, projects, delegation or
              computer actions still need the window open. New approvals wait
              for you. Restart interrupts active background work for review.
            </small>
          </span>
        </div>
        <div className="settings-preference-row">
          <span role="status">
            {pending
              ? "Updating background execution…"
              : status?.running
                ? `Running · ${status.activeWork} active`
                : status?.supported === false
                  ? "Requires the installed Windows app"
                  : status
                    ? "Stopped"
                    : error
                      ? "Background connection unavailable"
                      : "Checking background execution…"}
          </span>
          <div>
            <button
              type="button"
              disabled={pending || !status?.supported}
              onClick={() => void act(status?.running ? "stop" : "start")}
            >
              {status?.running
                ? "Stop background work"
                : "Start background worker"}
            </button>
            {status?.running && (
              <button
                type="button"
                disabled={pending}
                onClick={() => void act("restart")}
              >
                Restart worker
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => void act("refresh")}
            >
              Refresh status
            </button>
          </div>
        </div>
        {error && (
          <p className="settings-status" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
