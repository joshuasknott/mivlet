import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  CodingRepository,
  LocalComputerEpochRequest,
  PullRequestActivity,
  PullRequestCommentDraft,
  PullRequestFile,
  PullRequestLocalState,
  PullRequestPage,
  PullRequestRequest,
  PullRequestSummary,
} from "@mivlet/protocol";
import {
  readPullRequest,
  savePullRequestState,
  setPullRequestWatch,
} from "../../runtime/domains/pull-requests";
import { loadCollaboration } from "../../runtime/domains/collaboration";
import "./pull-request-review.css";

type Epoch = () => Promise<LocalComputerEpochRequest>;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function PullRequestReview({
  repository,
  epoch,
  workspaceId,
  agentId,
}: {
  repository: CodingRepository;
  epoch: Epoch;
  workspaceId: string;
  agentId: string;
}) {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState<number | null>(() => {
    const match = repository.publication?.match(/\/pull\/(\d+)$/);
    return match ? Number(match[1]) : null;
  });
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["pr-list", workspaceId, agentId, repository.id, page],
    enabled: open,
    retry: false,
    gcTime: 0,
    queryFn: async () =>
      readPullRequest<PullRequestPage<PullRequestSummary>>(await epoch(), {
        repositoryId: repository.id,
        action: "list",
        page,
      }),
  });
  return (
    <details
      className="pull-request-review"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Pull requests</summary>
      {open && (
        <>
          <button
            type="button"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            Refresh pull requests
          </button>
          {list.isPending && <p role="status">Loading pull requests…</p>}
          {list.error && <p role="alert">{message(list.error)}</p>}
          {list.data && (
            <>
              <label>
                Pull request
                <select
                  value={number ?? ""}
                  onChange={(event) =>
                    setNumber(Number(event.target.value) || null)
                  }
                >
                  <option value="">Select a pull request</option>
                  {number !== null &&
                    !list.data.items.some((pr) => pr.number === number) && (
                      <option value={number}>
                        #{number} · linked pull request
                      </option>
                    )}
                  {list.data.items.map((pr) => (
                    <option key={pr.number} value={pr.number}>
                      #{pr.number} · {pr.title} · {pr.state}
                    </option>
                  ))}
                </select>
              </label>
              {!list.data.items.length && <p>No pull requests on this page.</p>}
              {list.data.limitReached && (
                <p>
                  The listing limit was reached. Continue reviewing on GitHub.
                </p>
              )}
              <PageControls
                page={page}
                next={list.data.nextPage}
                change={setPage}
              />
            </>
          )}
          {number !== null && (
            <Detail
              key={repository.id + ":" + number}
              {...{ repository, number, epoch, workspaceId, agentId }}
            />
          )}
        </>
      )}
    </details>
  );
}
function PageControls({
  page,
  next,
  change,
}: {
  page: number;
  next: number | null;
  change: (page: number) => void;
}) {
  return (
    <div className="pull-request-review__actions">
      <button
        type="button"
        disabled={page === 1}
        onClick={() => change(page - 1)}
      >
        Previous page
      </button>
      <span>Page {page}</span>
      <button
        type="button"
        disabled={next === null}
        onClick={() => next !== null && change(next)}
      >
        Next page
      </button>
    </div>
  );
}
function Detail({
  repository,
  number,
  epoch,
  workspaceId,
  agentId,
}: {
  repository: CodingRepository;
  number: number;
  epoch: Epoch;
  workspaceId: string;
  agentId: string;
}) {
  const detail = useQuery({
    queryKey: ["pr-detail", workspaceId, agentId, repository.id, number],
    retry: false,
    gcTime: 0,
    queryFn: async () =>
      readPullRequest<PullRequestSummary>(await epoch(), {
        repositoryId: repository.id,
        number,
        action: "detail",
      }),
  });
  const local = useQuery({
    queryKey: ["pr-local", workspaceId, agentId, repository.id, number],
    retry: false,
    gcTime: 0,
    queryFn: async () =>
      savePullRequestState(await epoch(), {
        repositoryId: repository.id,
        number,
        action: "state",
      }),
    refetchInterval: 30_000,
  });
  const pr = detail.data;
  if (detail.error) return <p role="alert">{message(detail.error)}</p>;
  if (!pr) return <p role="status">Loading review…</p>;
  const identity = {
    repositoryId: repository.id,
    number,
    remote: repository.remote ?? "",
    expectedHead: pr.head,
    headBranch: pr.headBranch,
    baseSha: pr.base,
    baseBranch: pr.baseBranch,
  };
  return (
    <section aria-label={"Pull request " + number}>
      <p>
        <a href={pr.url} target="_blank" rel="noreferrer">
          #{number} {pr.title}
        </a>{" "}
        · {pr.state}
        {pr.draft ? " · Draft" : ""}
      </p>
      <p>
        <code>{pr.headBranch}</code> → <code>{pr.baseBranch}</code>
        <br />
        Reviewed commit <code>{pr.head.slice(0, 12)}</code>
      </p>
      {pr.body && (
        <details>
          <summary>Description</summary>
          <article>
            <pre>{pr.body}</pre>
          </article>
        </details>
      )}
      <button
        type="button"
        onClick={() => void detail.refetch()}
        disabled={detail.isFetching}
      >
        Refresh PR and commit
      </button>
      {local.error && <p role="alert">{message(local.error)}</p>}
      {local.data?.pending && (
        <p role="alert">
          A remote action has an uncertain outcome. Ask the agent to reconcile
          it before making another change. Mivlet will not retry it.
        </p>
      )}
      <ReviewPages
        key={"files:" + pr.head + ":" + pr.base}
        epoch={epoch}
        identity={identity}
        local={local.data ?? null}
        refreshed={() => void local.refetch()}
      />
      {local.data && (
        <DraftReview
          key="draft"
          epoch={epoch}
          identity={identity}
          state={local.data}
          refreshed={() => void local.refetch()}
        />
      )}
      <WatchControl
        {...{ epoch, identity, workspaceId, agentId }}
        state={local.data ?? null}
        closed={pr.state !== "open"}
        refreshed={() => void local.refetch()}
      />
    </section>
  );
}
function ReviewPages({
  epoch,
  identity,
  local,
  refreshed,
}: {
  epoch: Epoch;
  identity: PullRequestRequestIdentity;
  local: PullRequestLocalState | null;
  refreshed: () => void;
}) {
  const [tab, setTab] = useState("files");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const rows = useQuery({
    queryKey: [
      "pr-page",
      identity.repositoryId,
      identity.number,
      identity.expectedHead,
      identity.baseSha,
      tab,
      page,
    ],
    retry: false,
    gcTime: 0,
    queryFn: async () =>
      readPullRequest<PullRequestPage<PullRequestFile & PullRequestActivity>>(
        await epoch(),
        { ...identity, action: tab, page },
      ),
  });
  const viewed = useMutation({
    mutationFn: async (file: PullRequestFile) =>
      savePullRequestState(await epoch(), {
        ...identity,
        action: "viewed",
        path: file.path,
        revision: file.revision,
        page,
        viewed: local?.review?.viewed[file.path] !== file.revision,
      }),
    onSuccess: refreshed,
  });
  const filtered = rows.data?.items.filter((row) =>
    [row.path, row.patch, row.body, row.name, row.context]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <div
        className="pull-request-review__actions"
        aria-label="Review sections"
      >
        {[
          "files",
          "checks",
          "statuses",
          "reviews",
          "comments",
          "discussion",
        ].map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value);
              setPage(1);
              setSearch("");
            }}
          >
            {value}
          </button>
        ))}
      </div>
      <label>
        Find in this page
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {rows.isPending && <p role="status">Loading {tab}…</p>}
      {(rows.error || viewed.error) && (
        <p role="alert">{message(rows.error ?? viewed.error)}</p>
      )}
      {filtered?.map((row, index) =>
        tab === "files" ? (
          <details key={row.path} className="pull-request-review__file">
            <summary>
              {row.path} · +{row.additions} −{row.deletions}
              {local?.review?.viewed[row.path] &&
              local.review.viewed[row.path] !== row.revision
                ? " · Changed since viewed"
                : ""}
            </summary>
            <label>
              <input
                type="checkbox"
                checked={local?.review?.viewed[row.path] === row.revision}
                disabled={viewed.isPending || row.patchUnavailable}
                onChange={() => viewed.mutate(row)}
              />
              Viewed this revision
            </label>
            {row.previousPath && <p>Previously {row.previousPath}</p>}
            {row.patchUnavailable ? (
              <p>
                GitHub did not provide a complete text patch. Inspect this file
                on GitHub before reviewing.
              </p>
            ) : (
              <pre aria-label={"Diff for " + row.path}>{row.patch}</pre>
            )}
          </details>
        ) : (
          <article key={row.id ?? index}>
            <strong>
              {row.name ?? row.context ?? row.user?.login ?? "GitHub activity"}
            </strong>
            <p>
              {row.conclusion ?? row.state ?? row.status}
              {row.path ? " · " + row.path + ":" + (row.line ?? "") : ""}
            </p>
            {row.body && <pre>{row.body}</pre>}
          </article>
        ),
      )}
      {rows.data && (
        <>
          {!filtered?.length && <p>No matching {tab} on this page.</p>}
          {rows.data.limitReached && (
            <p>
              The review listing limit was reached. This collection may be
              incomplete; continue on GitHub.
            </p>
          )}
          <PageControls
            page={page}
            next={rows.data.nextPage}
            change={setPage}
          />
        </>
      )}
    </>
  );
}
type PullRequestRequestIdentity = Pick<
  PullRequestRequest,
  | "repositoryId"
  | "number"
  | "remote"
  | "expectedHead"
  | "headBranch"
  | "baseSha"
  | "baseBranch"
>;
function DraftReview({
  epoch,
  identity,
  state,
  refreshed,
}: {
  epoch: Epoch;
  identity: PullRequestRequestIdentity;
  state: PullRequestLocalState;
  refreshed: () => void;
}) {
  const [body, setBody] = useState(state.review?.body ?? "");
  const [draftHead, setDraftHead] = useState(
    state.review?.head ?? identity.expectedHead,
  );
  const [comments, setComments] = useState<PullRequestCommentDraft[]>(
    state.review?.comments ?? [],
  );
  const save = useMutation({
    mutationFn: async () =>
      savePullRequestState(await epoch(), {
        ...identity,
        action: "draft",
        body,
        comments,
      }),
    onSuccess: (result) => {
      if (result?.review) setDraftHead(result.review.head);
      refreshed();
    },
  });
  const dirty =
    body !== (state.review?.body ?? "") ||
    JSON.stringify(comments) !== JSON.stringify(state.review?.comments ?? []);
  return (
    <details>
      <summary>Draft review · local</summary>
      {draftHead && draftHead !== identity.expectedHead && (
        <p role="alert">
          The PR has new commits. Recheck draft comments against the current
          diff before saving or submitting.
        </p>
      )}
      <label>
        Review summary
        <textarea
          value={body}
          maxLength={12000}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {comments.map((comment, index) => (
        <fieldset key={index}>
          <legend>Inline comment {index + 1}</legend>
          <label>
            File path
            <input
              value={comment.path}
              onChange={(event) =>
                setComments(
                  comments.map((item, n) =>
                    n === index ? { ...item, path: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <label>
            Diff line
            <input
              type="number"
              min={1}
              value={comment.line}
              onChange={(event) =>
                setComments(
                  comments.map((item, n) =>
                    n === index
                      ? { ...item, line: Number(event.target.value) }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label>
            Side
            <select
              value={comment.side}
              onChange={(event) =>
                setComments(
                  comments.map((item, n) =>
                    n === index
                      ? {
                          ...item,
                          side:
                            event.target.value === "LEFT" ? "LEFT" : "RIGHT",
                        }
                      : item,
                  ),
                )
              }
            >
              <option value="RIGHT">New version</option>
              <option value="LEFT">Old version</option>
            </select>
          </label>
          <label>
            Comment
            <textarea
              value={comment.body}
              maxLength={4000}
              onChange={(event) =>
                setComments(
                  comments.map((item, n) =>
                    n === index ? { ...item, body: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            onClick={() => setComments(comments.filter((_, n) => n !== index))}
          >
            Remove comment {index + 1}
          </button>
        </fieldset>
      ))}
      <div className="pull-request-review__actions">
        <button
          type="button"
          disabled={comments.length >= 30}
          onClick={() =>
            setComments([
              ...comments,
              { path: "", line: 1, side: "RIGHT", body: "" },
            ])
          }
        >
          Add inline comment
        </button>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          Save local draft
        </button>
      </div>
      {dirty && <p role="status">Unsaved local draft.</p>}
      {save.isSuccess && !dirty && <p role="status">Draft saved locally.</p>}
      {save.error && <p role="alert">{message(save.error)}</p>}
      <p>
        Ask your agent to load this draft and submit a comment, approval or
        request for changes. The exact remote action goes through Mivlet’s
        approval prompt.
      </p>
    </details>
  );
}
function WatchControl({
  epoch,
  identity,
  state,
  workspaceId,
  agentId,
  closed,
  refreshed,
}: {
  epoch: Epoch;
  identity: PullRequestRequestIdentity;
  state: PullRequestLocalState | null;
  workspaceId: string;
  agentId: string;
  closed: boolean;
  refreshed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [workId, setWorkId] = useState("");
  const work = useQuery({
    queryKey: ["pr-watch-work", workspaceId, agentId],
    queryFn: () => loadCollaboration(workspaceId),
    enabled: open,
    retry: false,
    gcTime: 0,
  });
  const candidates = work.data?.work.filter(
    (item) =>
      item.agentId === agentId &&
      !item.parentId &&
      !item.schedule &&
      !["cancelled", "failed", "awaiting-user", "blocked"].includes(
        item.status,
      ),
  );
  const change = useMutation({
    mutationFn: async (action: "start" | "stop") => {
      const selected = candidates?.find((item) => item.id === workId);
      return setPullRequestWatch(await epoch(), {
        ...identity,
        action,
        workId,
        workGeneration: selected?.generation,
        watchId: state?.watch?.id,
      });
    },
    onSuccess: refreshed,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>PR watch{state?.watch?.active ? " · Active" : ""}</summary>
      {state?.watch?.active && <p>Watching PR #{state.watch.number}.</p>}
      <p>
        While Mivlet is open, relevant checks, reviews or conflicts can wake
        selected Work. Your own comments and duplicate updates stay quiet. Stops
        after ten updates, Stop, restart, closure or lost access.
      </p>
      {state?.watch?.reason && <p role="status">{state.watch.reason}</p>}
      {state?.watch?.active ? (
        <button
          type="button"
          disabled={change.isPending}
          onClick={() => change.mutate("stop")}
        >
          Stop PR watch
        </button>
      ) : (
        <>
          <label>
            Work to wake
            <select
              value={workId}
              onChange={(event) => setWorkId(event.target.value)}
            >
              <option value="">Choose existing Work</option>
              {candidates?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.userRequest.slice(0, 100)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              !workId || closed || change.isPending || Boolean(state?.pending)
            }
            onClick={() => change.mutate("start")}
          >
            Start PR watch
          </button>
        </>
      )}
      {(change.error || work.error) && (
        <p role="alert">{message(change.error ?? work.error)}</p>
      )}
    </details>
  );
}
