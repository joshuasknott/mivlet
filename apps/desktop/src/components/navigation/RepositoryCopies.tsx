import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  LocalComputerEpochRequest,
  RepositoryCopyCleanupPreview,
} from "@mivlet/protocol";
import { loadRuntimeLocalComputer } from "../../runtime/domains/local-computer";
import {
  deleteRepositoryCopy,
  inspectRepositoryCopies,
  previewRepositoryCopyCleanup,
  selectRepositoryCopy,
} from "../../runtime/domains/repository-copies";
import "./repository-copies.css";

export function formatCopyBytes(bytes: number | null) {
  if (bytes === null) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function RepositoryCopies({
  workspaceId,
  agentId,
  name,
  onSelectionChange,
}: {
  workspaceId: string;
  agentId: string;
  name: string;
  onSelectionChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{
    result: RepositoryCopyCleanupPreview;
    target: LocalComputerEpochRequest;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview) previewRef.current?.focus();
  }, [preview]);
  const epoch = async () => {
    const target = { workspaceId, agentId };
    const computer = await loadRuntimeLocalComputer(target);
    if (!computer)
      throw new Error(
        "Open the desktop app to manage retained repository copies.",
      );
    if (!computer.plugins?.computer)
      throw new Error(
        "Enable Computer Use in Plugins to manage repository copies.",
      );
    return { ...target, expectedGeneration: computer.generation };
  };
  const inventory = useQuery({
    queryKey: ["repository-copies", workspaceId, agentId],
    enabled: open,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const result = await inspectRepositoryCopies(await epoch());
      if (!result)
        throw new Error("Open the desktop app to inspect repository copies.");
      return result;
    },
  });
  const refresh = () => {
    void inventory.refetch();
    onSelectionChange();
  };
  const inspect = useMutation({
    mutationFn: async (repositoryId: string) => {
      const target = await epoch();
      const result = await previewRepositoryCopyCleanup({
        target,
        repositoryId,
        previewToken: null,
      });
      if (!result)
        throw new Error("Open the desktop app to inspect a cleanup preview.");
      return { result, target };
    },
    onSuccess: (next) => {
      setPreview(next);
      setConfirmed(false);
    },
  });
  const select = useMutation({
    mutationFn: async (repositoryId: string) => {
      const result = await selectRepositoryCopy({
        target: await epoch(),
        repositoryId,
        previewToken: null,
      });
      if (result === null)
        throw new Error("Open the desktop app to select a repository copy.");
    },
    onSuccess: () => {
      setPreview(null);
      refresh();
    },
  });
  const cleanup = useMutation({
    mutationFn: async () => {
      if (!preview?.result.previewToken || !confirmed)
        throw new Error("Review and confirm the exact cleanup first.");
      const result = await deleteRepositoryCopy({
        target: preview.target,
        repositoryId: preview.result.copy.id,
        previewToken: preview.result.previewToken,
      });
      if (result === null)
        throw new Error("Open the desktop app to remove a repository copy.");
    },
    onSettled: () => {
      setPreview(null);
      setConfirmed(false);
      refresh();
    },
  });
  const error =
    cleanup.error ?? select.error ?? inspect.error ?? inventory.error;
  const pending = cleanup.isPending || select.isPending || inspect.isPending;
  const clearErrors = () => {
    cleanup.reset();
    select.reset();
    inspect.reset();
  };
  const copies = inventory.data?.copies ?? [];
  return (
    <details
      className="repository-copies"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) {
          setPreview(null);
          setConfirmed(false);
        }
      }}
    >
      <summary>Retained copies</summary>
      {open && (
        <>
          <p>
            Repository copies in this account. Choose an agent above to reopen
            or clean up its copies. Cleanup protects unfinished work.
          </p>
          <button
            type="button"
            disabled={inventory.isFetching || pending}
            onClick={() => {
              clearErrors();
              setPreview(null);
              void inventory.refetch();
            }}
          >
            Refresh copies
          </button>
          {inventory.isPending && (
            <p role="status">Inspecting repository copies…</p>
          )}
          {inventory.data?.busy && (
            <p role="status">
              A repository operation is active. Refresh after it finishes.
            </p>
          )}
          {error && (
            <p role="alert">
              {error instanceof Error
                ? error.message
                : "Copy management failed. Refresh and try again."}
            </p>
          )}
          {inventory.isSuccess && copies.length === 0 && (
            <p>No retained repository copies in this account.</p>
          )}
          {copies.length > 0 && (
            <p>
              {formatCopyBytes(
                copies.reduce(
                  (total, copy) => total + (copy.sizeBytes ?? 0),
                  0,
                ),
              )}{" "}
              measured file bytes
              {copies.some((copy) => copy.sizeBytes === null)
                ? "; some sizes unavailable"
                : ""}
              . Disk allocation may differ.
            </p>
          )}
          <ul className="repository-copies__list">
            {copies.map((copy) => (
              <li key={`${copy.agentId}:${copy.id}`}>
                <strong>{copy.name}</strong>{" "}
                {copy.selected && <span>· Selected</span>}
                <p>
                  {copy.cleanupPending
                    ? "Cleanup interrupted"
                    : copy.dirty === null
                      ? "Changes unavailable"
                      : copy.dirty
                        ? "Uncommitted or ignored files"
                        : "Clean"}{" "}
                  · {formatCopyBytes(copy.sizeBytes)}
                </p>
                <details>
                  <summary>Copy details</summary>
                  <dl>
                    <dt>Owner</dt>
                    <dd>
                      {copy.ownershipVerified
                        ? `${copy.agentId === agentId ? name : copy.agentId} · ${copy.agentId}`
                        : "Ownership unclear; copy protected"}
                    </dd>
                    <dt>Account storage</dt>
                    <dd>{copy.accountId}</dd>
                    <dt>Workspace</dt>
                    <dd>{copy.workspaceId}</dd>
                    <dt>Source repository</dt>
                    <dd>{copy.sourceRepository ?? "Unknown source"}</dd>
                    <dt>Managed path</dt>
                    <dd>
                      <code>{copy.managedPath}</code> (within this account)
                    </dd>
                    <dt>Branch</dt>
                    <dd>
                      <code>{copy.branch ?? "Unavailable"}</code>
                    </dd>
                    <dt>HEAD</dt>
                    <dd>
                      <code>{copy.head ?? "Unavailable"}</code>
                    </dd>
                    <dt>Execution</dt>
                    <dd>{copy.jobsStatus}</dd>
                    <dt>Checkpoints</dt>
                    <dd>{copy.checkpointsStatus}</dd>
                  </dl>
                  {copy.linkedWork.length > 0 && (
                    <>
                      <p>
                        Work belonging to this agent; older records do not
                        identify an exact repository copy:
                      </p>
                      <ul>
                        {copy.linkedWork.map((work) => (
                          <li key={work.id}>
                            <code>{work.id}</code> · {work.status}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {copy.liveJobs.length > 0 && (
                    <>
                      <p>
                        Workspace execution or recovery; exact copy attribution
                        is unavailable:
                      </p>
                      <ul>
                        {copy.liveJobs.map((job) => (
                          <li key={job.id}>
                            <code>{job.id}</code> · {job.status}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {copy.blockers.length > 0 && (
                    <ul aria-label="Cleanup protections">
                      {copy.blockers.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </details>
                <div className="repository-copies__actions">
                  {!copy.selected && !copy.cleanupPending && (
                    <button
                      type="button"
                      disabled={
                        copy.agentId !== agentId ||
                        pending ||
                        inventory.data?.busy ||
                        copy.branch === null
                      }
                      onClick={() => select.mutate(copy.id)}
                    >
                      Use this copy
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={
                      copy.agentId !== agentId ||
                      pending ||
                      inventory.data?.busy
                    }
                    onClick={() => {
                      clearErrors();
                      setPreview(null);
                      inspect.mutate(copy.id);
                    }}
                  >
                    {copy.cleanupPending
                      ? "Review cleanup retry"
                      : "Review cleanup"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {preview && (
            <section
              ref={previewRef}
              tabIndex={-1}
              className="repository-copies__preview"
              aria-label="Exact repository cleanup preview"
            >
              <h4>
                {preview.result.previewToken
                  ? "Confirm copy cleanup"
                  : "This copy is protected"}
              </h4>
              <p>
                <strong>{preview.result.copy.name}</strong> ·{" "}
                <code>{preview.result.copy.id}</code>
              </p>
              <p>
                <code>{preview.result.copy.managedPath}</code>
                <br />
                {formatCopyBytes(preview.result.copy.sizeBytes)} · HEAD{" "}
                <code>{preview.result.copy.head ?? "cleanup recovery"}</code>
              </p>
              {preview.result.copy.blockers.length > 0 ? (
                <ul>
                  {preview.result.copy.blockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <>
                  <p>
                    Remove this managed copy permanently.{" "}
                    {preview.result.copy.selected &&
                      "It will also be deselected. "}
                    The source repository remains intact. This preview expires
                    in {preview.result.expiresInSeconds} seconds; any change
                    requires another review.
                  </p>
                  <label className="repository-copies__confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I reviewed this copy and want to remove it.
                  </label>
                  <button
                    type="button"
                    disabled={!confirmed || pending}
                    onClick={() => cleanup.mutate()}
                  >
                    {cleanup.isPending
                      ? "Removing copy…"
                      : "Permanently remove this copy"}
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setPreview(null);
                  setConfirmed(false);
                }}
              >
                Close cleanup preview
              </button>
            </section>
          )}
        </>
      )}
    </details>
  );
}
