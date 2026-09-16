import { useState } from "react";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import { activeWork } from "../../lib/workspace-execution";
import { WorkStatusBadge } from "./WorkStatusBadge";
import "./work.css";

/** Compact reusable Work card. Callbacks are narrow; the shell routes them.
 * A started request never offers blind retry here: recovery with review lives
 * in WorkDetails, where the reconcile acknowledgement is explicit. */
export function WorkCard({
  item,
  onOpen,
  onOpenWork,
  onStop,
  onContinue,
  onSteer,
}: {
  item: CollaborationWorkItem;
  onOpen: (conversationId: string) => void;
  onOpenWork?: (id: string) => void;
  onStop: (id: string) => void | Promise<void>;
  onContinue: (id: string, expectedGeneration: number) => void | Promise<void>;
  onSteer: (
    id: string,
    expectedGeneration: number,
    text: string,
  ) => void | Promise<void>;
}) {
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<"steer" | "stop" | "continue" | null>(
    null,
  );
  const [error, setError] = useState("");
  const unstarted =
    item.runIds.length === 0 &&
    item.turnCount === 0 &&
    item.outputs.length === 0;
  const request = item.userRequest || item.prompt;
  const run = async (
    kind: "steer" | "stop" | "continue",
    action: () => void | Promise<void>,
  ) => {
    if (pending) return;
    setPending(kind);
    setError("");
    try {
      await action();
      if (kind === "steer") {
        setText("");
        setSteering(false);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This Work action could not be completed.",
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <article className="work-card" data-status={item.status}>
      <header className="work-card-header">
        <strong>{item.agentName}</strong>
        <WorkStatusBadge item={item} />
      </header>
      <p className="work-card-prompt">
        {request.length > 220 ? `${request.slice(0, 220)}…` : request}
      </p>
      {item.reason ? <p className="work-card-reason">{item.reason}</p> : null}
      {item.attachments?.length ? (
        <small className="work-card-meta">
          {item.attachments.length} attached file
          {item.attachments.length === 1 ? "" : "s"}
        </small>
      ) : null}
      {error ? (
        <p className="work-card-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="work-card-actions">
        {onOpenWork ? (
          <button type="button" onClick={() => onOpenWork(item.id)}>
            Work details
          </button>
        ) : null}
        <button type="button" onClick={() => onOpen(item.conversationId)}>
          Open conversation
        </button>
        {activeWork(item) ? (
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => void run("stop", () => onStop(item.id))}
          >
            Stop
          </button>
        ) : null}
        {unstarted && !activeWork(item) && item.status !== "completed" ? (
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() =>
              void run("continue", () =>
                onContinue(item.id, item.generation),
              )
            }
          >
            Retry request
          </button>
        ) : null}
        {item.status !== "completed" ? (
          <button
            type="button"
            aria-expanded={steering}
            onClick={() => setSteering((open) => !open)}
          >
            Steer
          </button>
        ) : null}
      </div>
      {steering ? (
        <form
          className="work-steer-form"
          onSubmit={(event) => {
            event.preventDefault();
            const instruction = text.trim();
            if (!instruction) return;
            void run("steer", () =>
              onSteer(item.id, item.generation, instruction),
            );
          }}
        >
          <label>
            Steering instruction
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={2}
              placeholder="Adjust this request at its next safe boundary…"
            />
          </label>
          <button
            type="submit"
            disabled={Boolean(pending) || !text.trim()}
          >
            {pending === "steer" ? "Applying…" : "Apply steering"}
          </button>
        </form>
      ) : null}
    </article>
  );
}

/** Reusable unified Work list over the same narrow callbacks. */
export function WorkList({
  work,
  empty,
  onOpen,
  onOpenWork,
  onStop,
  onContinue,
  onSteer,
}: {
  work: CollaborationWorkItem[];
  empty: string;
  onOpen: (conversationId: string) => void;
  onOpenWork?: (id: string) => void;
  onStop: (id: string) => void | Promise<void>;
  onContinue: (id: string, expectedGeneration: number) => void | Promise<void>;
  onSteer: (
    id: string,
    expectedGeneration: number,
    text: string,
  ) => void | Promise<void>;
}) {
  if (!work.length) return <p className="work-empty">{empty}</p>;
  return (
    <ol className="work-list">
      {[...work]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((item) => (
          <li key={item.id}>
            <WorkCard
              item={item}
              onOpen={onOpen}
              onOpenWork={onOpenWork}
              onStop={onStop}
              onContinue={onContinue}
              onSteer={onSteer}
            />
          </li>
        ))}
    </ol>
  );
}