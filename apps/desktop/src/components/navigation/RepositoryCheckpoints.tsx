import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  LocalComputerEpochRequest,
  RepositoryCheckpoint,
  RepositoryCheckpointPreview,
} from "@mivlet/protocol";
import {
  cancelRuntimeLocalComputer,
  loadRuntimeLocalComputer,
} from "../../runtime/domains/local-computer";
import {
  executeCheckpointAction,
  listRepositoryCheckpoints,
  prepareCheckpointAction,
  previewRepositoryCheckpoint,
  type CheckpointAction,
} from "../../runtime/domains/repository-checkpoints";
import "./repository-checkpoints.css";

export function RepositoryCheckpoints({
  workspaceId,
  agentId,
  repositoryId,
  disabled,
  onChanged,
}: {
  workspaceId: string;
  agentId: string;
  repositoryId: string;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [review, setReview] = useState<{
    value: RepositoryCheckpointPreview;
    target: LocalComputerEpochRequest;
  } | null>(null);
  const [action, setAction] = useState<CheckpointAction | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [activeTarget, setActiveTarget] =
    useState<LocalComputerEpochRequest | null>(null);
  const epoch = async () => {
    const computer = await loadRuntimeLocalComputer({ workspaceId, agentId });
    if (!computer?.plugins?.computer)
      throw new Error(
        "Enable Computer Use in the desktop app to use repository checkpoints.",
      );
    const target = {
      workspaceId,
      agentId,
      expectedGeneration: computer.generation,
    };
    setActiveTarget(target);
    return target;
  };
  const list = useQuery({
    queryKey: ["repository-checkpoints", workspaceId, agentId, repositoryId],
    enabled: open && !disabled,
    retry: false,
    gcTime: 0,
    queryFn: async () => listRepositoryCheckpoints(await epoch(), repositoryId),
  });
  const preview = useMutation({
    mutationFn: async (checkpoint: RepositoryCheckpoint) => {
      setReview(null);
      setAction(null);
      setMessage("");
      setConfirmation("");
      const target = await epoch();
      const value = await previewRepositoryCheckpoint(
        target,
        repositoryId,
        checkpoint.id,
      );
      if (!value)
        throw new Error("Open the desktop app to preview checkpoint files.");
      return { value, target };
    },
    onSuccess: setReview,
  });
  const prepare = useMutation({
    mutationFn: async (value: {
      kind: "capture" | "delete";
      checkpoint?: RepositoryCheckpoint;
    }) => {
      setMessage("");
      setConfirmation("");
      const target = await epoch();
      return prepareCheckpointAction(
        target,
        value.kind,
        value.kind === "capture"
          ? { repositoryId, label: label.trim() }
          : {
              repositoryId,
              checkpointId: value.checkpoint!.id,
              expectedCheckpointTree: value.checkpoint!.treeId,
            },
      );
    },
    onSuccess: setAction,
  });
  const execute = useMutation({
    mutationFn: async () => {
      if (!action) throw new Error("Review the checkpoint action first.");
      return executeCheckpointAction(action, confirmation);
    },
    onSuccess: () => {
      setMessage(
        action?.tool.endsWith("restore")
          ? "Files restored. Run the project's checks again. The previous code is saved as a checkpoint."
          : action?.tool.endsWith("delete")
            ? "Checkpoint deleted."
            : "Checkpoint saved.",
      );
      setAction(null);
      setConfirmation("");
      setReview(null);
      setLabel("");
      void list.refetch();
      onChanged();
    },
    onError: () => {
      setAction(null);
      setReview(null);
      setConfirmation("");
      onChanged();
    },
  });
  const stop = useMutation({
    mutationFn: async () => {
      if (activeTarget) await cancelRuntimeLocalComputer(activeTarget);
    },
    onSuccess: () => {
      setAction(null);
      setReview(null);
      setConfirmation("");
      setMessage("Stopped. Review repository status before continuing.");
      onChanged();
    },
  });
  const busy =
    preview.isPending ||
    prepare.isPending ||
    execute.isPending ||
    stop.isPending ||
    list.isFetching;
  const error =
    execute.error ?? stop.error ?? prepare.error ?? preview.error ?? list.error;
  function resetFeedback() {
    execute.reset();
    stop.reset();
    prepare.reset();
    preview.reset();
    setMessage("");
  }
  const beginRestore = () => {
    if (!review) return;
    resetFeedback();
    setConfirmation("");
    setAction(
      prepareCheckpointAction(review.target, "restore", {
        repositoryId,
        checkpointId: review.value.checkpoint.id,
        expectedTree: review.value.currentTreeId,
        expectedCheckpointTree: review.value.checkpoint.treeId,
        expectedOutput: review.value.outputTreeId,
        expectedHead: review.value.head,
      }),
    );
  };
  return (
    <details
      className="repository-checkpoints"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>File checkpoints</summary>
      {open && (
        <div className="repository-checkpoints__body">
          <p>
            Save and restore files in this agent's private copy. Ignored files,
            credentials and Git metadata are excluded.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              resetFeedback();
              prepare.mutate({ kind: "capture" });
            }}
          >
            <label>
              Checkpoint name
              <input
                value={label}
                maxLength={160}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Tests passing before refactor"
                disabled={busy || disabled || !!action}
              />
            </label>
            <button
              type="submit"
              disabled={!label.trim() || busy || disabled || !!action}
            >
              Save checkpoint
            </button>
          </form>
          <div className="repository-files__actions">
            <button
              type="button"
              onClick={() => {
                resetFeedback();
                setReview(null);
                setAction(null);
                void list.refetch();
              }}
              disabled={busy || disabled}
            >
              Refresh checkpoints
            </button>
            {busy && activeTarget && (
              <button
                type="button"
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
              >
                Stop checkpoint operation
              </button>
            )}
          </div>
          {disabled && (
            <p role="status">
              Finish or reconcile the repository operation before using checkpoints.
            </p>
          )}
          {busy && (
            <p role="status">
              {execute.isPending
                ? "Applying approved checkpoint action…"
                : preview.isPending
                  ? "Preparing exact file comparison…"
                  : "Loading checkpoints…"}
            </p>
          )}
          {error && (
            <p role="alert">
              {error instanceof Error
                ? error.message
                : "Checkpoint operation failed. Inspect repository status."}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {list.data && (
            <>
              <p>
                {list.data.checkpoints.length} / {list.data.maxCheckpoints}{" "}
                checkpoints ·{" "}
                {Math.ceil(
                  list.data.checkpoints.reduce((sum, c) => sum + c.bytes, 0) /
                    1024,
                )}{" "}
                KiB stored
              </p>
              {!list.data.checkpoints.length && (
                <p>No saved file checkpoints yet.</p>
              )}
              <ul className="repository-checkpoints__list">
                {list.data.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.id}>
                    <strong>{checkpoint.label}</strong>
                    <span>
                      {new Date(checkpoint.createdAt).toLocaleString()} ·{" "}
                      {checkpoint.fileCount} files
                    </span>
                    <div className="repository-files__actions">
                      <button
                        type="button"
                        disabled={busy || disabled || !!action}
                        onClick={() => {
                          resetFeedback();
                          preview.mutate(checkpoint);
                        }}
                        aria-label={`Preview ${checkpoint.label}`}
                      >
                        Preview restore
                      </button>
                      <button
                        type="button"
                        disabled={busy || disabled || !!action}
                        onClick={() => {
                          resetFeedback();
                          prepare.mutate({ kind: "delete", checkpoint });
                        }}
                        aria-label={`Delete ${checkpoint.label}`}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {review && (
            <section
              aria-label="Checkpoint restore preview"
              className="repository-checkpoints__review"
            >
              <h4>Restore “{review.value.checkpoint.label}”</h4>
              <p>
                {review.value.files.length} file changes, including additions and
                deletions. Current code is saved first; prior test verification
                is cleared. Git HEAD and chat history stay unchanged.
              </p>
              <ul>
                {review.value.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code> · {file.status}
                  </li>
                ))}
              </ul>
              <pre aria-label="Checkpoint file diff">
                {review.value.diff || "No code changes."}
              </pre>
              {review.value.truncated && (
                <p role="status">
                  Diff truncated. Review full affected files with the agent before restoring.
                </p>
              )}
              <details>
                <summary>Exact checkpoint and provenance</summary>
                <dl>
                  <dt>Checkpoint</dt>
                  <dd>{review.value.checkpoint.id}</dd>
                  <dt>Captured tree</dt>
                  <dd>{review.value.checkpoint.treeId}</dd>
                  <dt>Reviewed current tree</dt>
                  <dd>{review.value.currentTreeId}</dd>
                  <dt>Request</dt>
                  <dd>{review.value.checkpoint.requestId}</dd>
                </dl>
              </details>
              <button
                type="button"
                disabled={
                  busy ||
                  disabled ||
                  !!action ||
                  review.value.files.length === 0
                }
                onClick={beginRestore}
              >
                Review restore approval
              </button>
            </section>
          )}
          {action && (
            <form
              aria-label="Confirm checkpoint action"
              className="repository-checkpoints__confirmation"
              onSubmit={(event) => {
                event.preventDefault();
                execute.mutate();
              }}
            >
              <strong>
                {action.tool.endsWith("restore")
                  ? "Approve file restore"
                  : action.tool.endsWith("delete")
                    ? "Delete saved checkpoint"
                    : "Save file checkpoint"}
              </strong>
              {typeof action.arguments.checkpointId === "string" && (
                <p>
                  Checkpoint:{" "}
                  {
                    list.data?.checkpoints.find(
                      (checkpoint) =>
                        checkpoint.id === action.arguments.checkpointId,
                    )?.label
                  }
                  <br />
                  <code>{action.arguments.checkpointId}</code>
                </p>
              )}
              <p>{action.approval.consequence}</p>
              <label>
                Type <code>{action.approval.confirmationPhrase}</code>
                <input
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={execute.isPending}
                />
              </label>
              <div className="repository-files__actions">
                <button
                  type="submit"
                  disabled={
                    disabled ||
                    busy ||
                    confirmation !== action.approval.confirmationPhrase
                  }
                >
                  Approve once
                </button>
                <button
                  type="button"
                  disabled={execute.isPending}
                  onClick={() => {
                    setAction(null);
                    setConfirmation("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </details>
  );
}
