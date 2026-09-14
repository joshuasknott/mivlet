import { useState } from "react";
import type { CollaborationWorkItem, WorkOutput } from "@fable/protocol";
import { activeWork } from "../../lib/workspace-execution";
import { WorkStatusBadge } from "./WorkStatusBadge";
import "./work.css";

/**
 * Compact reusable Work card. Callbacks are narrow; the shell routes them.
 * A started request never offers blind retry here: recovery with review
 * lives in WorkDetails, where the reconcile acknowledgement is explicit.
 */
export function WorkCard({
  item,
  onOpen,
  onStop,
  onContinue,
  onSteer,
}: {
  item: CollaborationWorkItem;
  onOpen: (conversationId: string) => void;
  onStop: (id: string) => void;
  onContinue: (id: string, expectedGeneration: number) => void;
  onSteer: (id: string, expectedGeneration: number, text: string) => void;
}) {
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState("");
  const unstarted =
    item.runIds.length === 0 &&
    item.turnCount === 0 &&
    item.outputs.length === 0;
  const request = item.userRequest || item.prompt;
  return (
    <article className="work-card" data-status={item.status}>
      <header className="work-card-header">
        <strong>{item.agentName}</strong>
        <WorkStatusBadge status={item.status} origin={item.origin} />
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
      <div className="work-card-actions">
        <button type="button" onClick={() => onOpen(item.conversationId)}>
          Open conversation
        </button>
        {activeWork(item) ? (
          <button type="button" onClick={() => onStop(item.id)}>
            Stop
          </button>
        ) : null}
        {unstarted && !activeWork(item) && item.status !== "completed" ? (
          <button
            type="button"
            onClick={() => onContinue(item.id, item.generation)}
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
            onSteer(item.id, item.generation, instruction);
            setText("");
            setSteering(false);
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
          <button type="submit" disabled={!text.trim()}>
            Apply steering
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
  onStop,
  onContinue,
  onSteer,
}: {
  work: CollaborationWorkItem[];
  empty: string;
  onOpen: (conversationId: string) => void;
  onStop: (id: string) => void;
  onContinue: (id: string, expectedGeneration: number) => void;
  onSteer: (id: string, expectedGeneration: number, text: string) => void;
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
              onStop={onStop}
              onContinue={onContinue}
              onSteer={onSteer}
            />
          </li>
        ))}
    </ol>
  );
}

/** Callback bridge for one output's explicit promotion into Memory. */
export interface WorkOutputPromotion {
  (output: WorkOutput, work: CollaborationWorkItem): void | Promise<void>;
}