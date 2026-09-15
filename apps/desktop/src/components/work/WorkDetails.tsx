import { useState } from "react";
import type { CollaborationWorkItem, WorkOutput } from "@mivlet/protocol";
import { activeWork } from "../../lib/workspace-execution";
import {
  MAX_PROMOTED_MEMORY_VALUE,
  memoryPromotionDestination,
} from "../../lib/work-memory";
import { WorkStatusBadge } from "./WorkStatusBadge";
import "./work.css";

const ATTACHMENT_KINDS: Record<string, string> = {
  "workspace-file": "Verified workspace file",
  "knowledge-context": "Knowledge source",
  "image-input": "Transient image input",
  transient: "Upload held in memory",
};

type PendingAction = "stop" | "continue" | "steer" | null;

/**
 * The detailed Work view: original request, captured context, steering,
 * attachments, runs and saved results with explicit continuation and Memory
 * promotion. Every action reports failure and keeps unsaved input.
 */
export function WorkDetails({
  item,
  onOpen,
  onStop,
  onContinue,
  onSteer,
  onPromote,
}: {
  item: CollaborationWorkItem;
  onOpen: (conversationId: string) => void;
  onStop: (id: string) => void | Promise<void>;
  onContinue: (id: string, expectedGeneration: number) => void | Promise<void>;
  onSteer: (
    id: string,
    expectedGeneration: number,
    text: string,
  ) => void | Promise<void>;
  onPromote?: (
    output: WorkOutput,
    work: CollaborationWorkItem,
    value: string,
  ) => void | Promise<void>;
}) {
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState("");
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState("");
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoteText, setPromoteText] = useState("");
  const [promotePending, setPromotePending] = useState(false);
  const [promoteError, setPromoteError] = useState("");
  const [promoted, setPromoted] = useState<string | null>(null);
  const unstarted =
    item.runIds.length === 0 &&
    item.turnCount === 0 &&
    item.outputs.length === 0;
  const uncertain =
    item.status === "awaiting-user" && item.runIds.length > 0;
  const canContinue = !activeWork(item) && item.status !== "completed";
  const run = async (
    kind: PendingAction,
    action: () => void | Promise<void>,
    onSuccess?: () => void,
  ) => {
    if (pending) return;
    setPending(kind);
    setError("");
    try {
      await action();
      onSuccess?.();
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
  const save = async (output: WorkOutput) => {
    if (!onPromote || promotePending) return;
    setPromotePending(true);
    setPromoteError("");
    try {
      await onPromote(output, item, promoteText);
      setPromoted(output.runId);
      setPromoting(null);
      setPromoteText("");
    } catch (failure) {
      setPromoteError(
        failure instanceof Error
          ? failure.message
          : "This result could not be saved to memory.",
      );
    } finally {
      setPromotePending(false);
    }
  };
  return (
    <article className="work-details" data-status={item.status}>
      <header className="work-details-header">
        <strong>{item.agentName}</strong>
        <WorkStatusBadge item={item} />
      </header>
      <section className="work-details-section">
        <h3>Original request</h3>
        <p className="work-details-request">{item.userRequest}</p>
        {item.prompt && item.prompt !== item.userRequest ? (
          <>
            <h3>Assignment</h3>
            <p className="work-details-request">{item.prompt}</p>
          </>
        ) : null}
        {item.reason ? (
          <p className="work-details-reason">{item.reason}</p>
        ) : null}
        {uncertain ? (
          <p className="work-details-notice">
            This request was interrupted or steered after provider activity
            started. Its external effects are uncertain; review saved results
            before continuing. Nothing is replayed automatically.
          </p>
        ) : null}
      </section>
      {item.capturedContext ? (
        <section className="work-details-section">
          <h3>Captured context</h3>
          <small>
            Snapshot from{" "}
            {new Date(item.capturedContext.capturedAt).toLocaleString()} ·
            revision {item.capturedContext.sourceRevision} · frozen at
            admission; later Chat never alters it.
          </small>
          <details>
            <summary>Inspect captured context</summary>
            <pre className="work-details-context">
              {item.capturedContext.text}
            </pre>
          </details>
        </section>
      ) : null}
      {item.steering?.length ? (
        <section className="work-details-section">
          <h3>Steering</h3>
          <ol className="work-steering-list">
            {item.steering.map((steer) => (
              <li key={steer.id}>
                <small>{new Date(steer.createdAt).toLocaleString()}</small>
                <p>{steer.text}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {item.attachments?.length ? (
        <section className="work-details-section">
          <h3>Attachments</h3>
          <ul className="work-attachment-list">
            {item.attachments.map((ref) => (
              <li key={ref.id}>
                <span>{ref.name}</span>
                <small>
                  {ATTACHMENT_KINDS[ref.availability] ?? ref.availability}
                  {ref.relativePath ? ` · ${ref.relativePath}` : ""}
                </small>
                {ref.availability === "image-input" ||
                ref.availability === "transient" ? (
                  <small className="work-attachment-recovery">
                    Held in memory only; reattach it after a restart before
                    continuing.
                  </small>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {item.runIds.length ? (
        <section className="work-details-section">
          <h3>Progress</h3>
          <small>
            {item.runIds.length} provider run
            {item.runIds.length === 1 ? "" : "s"}
            {item.currentRunId ? ` · current: ${item.currentRunId}` : ""} ·{" "}
            {item.turnCount} / {item.maxTurns} turns ·{" "}
            {item.tokenUsage.toLocaleString()} /{" "}
            {item.maxTokens.toLocaleString()} reported tokens
          </small>
          {(item.prerequisites.length || item.waitingFor.length) ? (
            <small>
              {item.prerequisites.length
                ? `Needs ${item.prerequisites.length} prerequisite assignment(s). `
                : ""}
              {item.waitingFor.length
                ? `Waiting for ${item.waitingFor.length} delegated assignment(s).`
                : ""}
            </small>
          ) : null}
        </section>
      ) : null}
      {item.outputs.length ? (
        <section className="work-details-section">
          <h3>Saved results</h3>
          {item.outputs.map((output) => (
            <div className="work-details-output" key={output.runId}>
              <p>{output.text}</p>
              <small>
                Agent report · {new Date(output.createdAt).toLocaleString()}.
                External outcomes require their own evidence.
              </small>
              <div className="work-details-actions">
                <button
                  type="button"
                  onClick={() => onOpen(output.conversationId)}
                >
                  Open result conversation
                </button>
                {onPromote ? (
                  <button
                    type="button"
                    disabled={promotePending}
                    onClick={() => {
                      setPromoting(
                        promoting === output.runId ? null : output.runId,
                      );
                      setPromoteText(output.text.slice(0, MAX_PROMOTED_MEMORY_VALUE));
                      setPromoteError("");
                    }}
                  >
                    {promoted === output.runId
                      ? "Saved to memory"
                      : "Save to memory…"}
                  </button>
                ) : null}
              </div>
              {promoting === output.runId && onPromote ? (
                <form
                  className="work-promote-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(output);
                  }}
                >
                  <label>
                    Conclusion to keep in {memoryPromotionDestination(item)}
                    <textarea
                      value={promoteText}
                      rows={4}
                      maxLength={MAX_PROMOTED_MEMORY_VALUE}
                      onChange={(event) => {
                        setPromoteText(event.target.value);
                        setPromoteError("");
                      }}
                    />
                  </label>
                  <small>
                    {promoteText.length} / {MAX_PROMOTED_MEMORY_VALUE}{" "}
                    characters · saved with this run's provenance
                  </small>
                  <div className="work-details-actions">
                    <button
                      type="submit"
                      disabled={promotePending || !promoteText.trim()}
                    >
                      {promotePending ? "Saving…" : "Save to memory"}
                    </button>
                    <button
                      type="button"
                      disabled={promotePending}
                      onClick={() => setPromoting(null)}
                    >
                      Cancel
                    </button>
                  </div>
                  {promoteError ? (
                    <p role="alert">{promoteError}</p>
                  ) : null}
                </form>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {error ? (
        <p className="work-details-reason" role="alert">
          {error}
        </p>
      ) : null}
      <div className="work-details-actions">
        {activeWork(item) ? (
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => void run("stop", () => onStop(item.id))}
          >
            Stop
          </button>
        ) : null}
        {canContinue ? (
          <button
            type="button"
            disabled={Boolean(pending) || (!unstarted && !checked)}
            onClick={() =>
              void run("continue", () =>
                onContinue(item.id, item.generation),
              )
            }
          >
            {pending === "continue"
              ? "Starting…"
              : unstarted
                ? "Retry request"
                : "Continue"}
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
      {canContinue && !unstarted ? (
        <label className="work-reconcile-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          I have checked the previous outcome and reconciled any uncertain
          external effects.
        </label>
      ) : null}
      {steering ? (
        <form
          className="work-steer-form"
          onSubmit={(event) => {
            event.preventDefault();
            const instruction = text.trim();
            if (!instruction) return;
            void run(
              "steer",
              () => onSteer(item.id, item.generation, instruction),
              () => {
                setText("");
                setSteering(false);
              },
            );
          }}
        >
          <label>
            Steering instruction
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              placeholder="Applied at a safe boundary; prior outcomes are never replayed…"
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