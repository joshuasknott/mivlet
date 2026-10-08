import { useCallback, useEffect, useRef, useState } from "react";
import {
  backgroundWorkerStatus,
  controlBackgroundWorker,
  type BackgroundWorkerStatus,
} from "../../runtime/domains/background-worker";
import "./background-execution-settings.css";

type Action = "start" | "stop" | "restart" | "refresh";

export function BackgroundExecutionSettings() {
  const [status, setStatus] = useState<BackgroundWorkerStatus | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canStop =
    status?.running || (error !== null && status?.supported !== false);
  const generation = useRef(0);
  const act = useCallback(async (action: Action) => {
    const current = ++generation.current;
    setPending(action);
    try {
      const value =
        action === "refresh"
          ? await backgroundWorkerStatus()
          : await controlBackgroundWorker(action);
      if (current === generation.current) {
        setStatus(value);
        setError(null);
      }
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current === generation.current) setPending(null);
    }
  }, []);
  useEffect(() => {
    void act("refresh");
    return () => {
      generation.current++;
    };
  }, [act]);
  return (
    <section
      className="settings-group background-execution-settings"
      aria-labelledby="background-execution-heading"
    >
      <h2 id="background-execution-heading">Background execution</h2>
      <div className="settings-group__surface">
        <div className="settings-preference-row">
          <span>
            <strong>Keep supported work running after closing Mivlet</strong>
            <small>
              New Read Only text work and schedules can continue with Codex,
              Claude or supported APIs while Windows is awake and your session
              is valid. Find results in conversations and approved commands in
              Library.
            </small>
            <small>
              Other requests and new approvals need the window open. Restart
              interrupts work for review.
            </small>
          </span>
        </div>
        <div className="settings-preference-row">
          <span role="status" aria-label="Background execution">
            {pending
              ? "Updating background execution…"
              : error
                ? "Background connection unavailable"
                : status?.running
                  ? `Running · ${status.activeWork} active`
                  : status?.supported === false
                    ? "Requires the installed Windows app"
                    : status
                      ? "Stopped"
                      : "Checking background execution…"}
          </span>
          <div className="profile-action-row">
            <button
              type="button"
              className="button button--secondary"
              disabled={
                Boolean(pending && !(pending === "refresh" && canStop)) ||
                (!canStop && !status?.supported)
              }
              onClick={() => void act(canStop ? "stop" : "start")}
            >
              {canStop ? "Stop background work" : "Start background worker"}
            </button>
            {status?.running && !error && (
              <button
                type="button"
                className="button button--secondary"
                disabled={Boolean(pending)}
                onClick={() => void act("restart")}
              >
                Restart worker
              </button>
            )}
            <button
              type="button"
              className="button button--secondary"
              disabled={Boolean(pending)}
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
