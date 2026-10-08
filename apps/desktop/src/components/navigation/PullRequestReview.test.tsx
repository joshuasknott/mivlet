import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  CodingRepository,
  PullRequestLocalState,
  PullRequestRequest,
  PullRequestSummary,
} from "@mivlet/protocol";
import { PullRequestReview } from "./PullRequestReview";
import {
  readPullRequest,
  savePullRequestState,
  setPullRequestWatch,
} from "../../runtime/domains/pull-requests";
import { loadCollaboration } from "../../runtime/domains/collaboration";
vi.mock("../../runtime/domains/pull-requests", () => ({
  readPullRequest: vi.fn(),
  savePullRequestState: vi.fn(),
  setPullRequestWatch: vi.fn(),
}));
vi.mock("../../runtime/domains/collaboration", () => ({
  loadCollaboration: vi.fn(),
}));
const repository: CodingRepository = {
  id: "repo",
  name: "sample",
  branch: "mivlet/task",
  base: "base",
  baseBranch: "main",
  remote: "https://github.com/example/repository.git",
  operation: "idle",
  publication: "https://github.com/example/repository/pull/7",
  lastCommand: null,
  lastResult: null,
  commandDiffId: null,
};
const pr: PullRequestSummary = {
  number: 7,
  url: repository.publication!,
  title: "Fix calculation",
  body: "Changes",
  state: "open",
  draft: false,
  head: "a".repeat(40),
  headBranch: "mivlet/task",
  base: "b".repeat(40),
  baseBranch: "main",
  mergeable: true,
  author: "someone",
  updatedAt: "now",
};
const epoch = vi.fn(async () => ({
  workspaceId: "local",
  agentId: "agent",
  expectedGeneration: 7,
}));
let state: PullRequestLocalState;
beforeEach(() => {
  vi.clearAllMocks();
  state = {
    review: {
      head: pr.head,
      body: "Saved review",
      comments: [],
      viewed: { "sum.js": "old" },
    },
    pending: null,
    watch: null,
  };
  vi.mocked(savePullRequestState).mockImplementation(
    async (_target, request) => {
      if (request.action === "draft")
        state.review = {
          ...state.review!,
          body: request.body ?? "",
          comments: request.comments ?? [],
        };
      if (request.action === "viewed")
        state.review!.viewed[request.path!] = request.revision!;
      return structuredClone(state);
    },
  );
  vi.mocked(readPullRequest).mockImplementation(
    async <T,>(_target: unknown, request: PullRequestRequest): Promise<T> => {
      if (request.action === "list")
        return { items: [pr], nextPage: null } as T;
      if (request.action === "detail") return pr as T;
      return {
        items:
          request.action === "files"
            ? [
                {
                  path: "sum.js",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  revision: "new",
                  patch: "@@ -1 +1 @@\n-a - b\n+a + b",
                  patchUnavailable: false,
                },
              ]
            : [],
        nextPage: null,
      } as T;
    },
  );
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PullRequestReview
        repository={repository}
        epoch={epoch}
        workspaceId="local"
        agentId="agent"
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Pull requests", { selector: "summary" }));
}
it("shows real patches, labels changed revisions and sends exact viewed identity", async () => {
  setup();
  fireEvent.click(await screen.findByText(/sum.js.*Changed since viewed/));
  expect(screen.getByLabelText("Diff for sum.js")).toHaveTextContent("+a + b");
  fireEvent.click(screen.getByLabelText("Viewed this revision"));
  await waitFor(() =>
    expect(savePullRequestState).toHaveBeenCalledWith(
      { workspaceId: "local", agentId: "agent", expectedGeneration: 7 },
      expect.objectContaining({
        action: "viewed",
        repositoryId: "repo",
        number: 7,
        expectedHead: pr.head,
        baseSha: pr.base,
        path: "sum.js",
        revision: "new",
        viewed: true,
      }),
    ),
  );
});
it("keeps draft saving local and shows pending outcomes without retrying mutations", async () => {
  state.pending = {
    request: { repositoryId: "repo", action: "review" },
    startedAt: "now",
  };
  setup();
  fireEvent.click(await screen.findByText("Draft review · local"));
  fireEvent.change(screen.getByLabelText("Review summary"), {
    target: { value: "Inspect overflow" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save local draft" }));
  expect(await screen.findByText("Draft saved locally.")).toBeVisible();
  expect(
    screen.getByText(/remote action has an uncertain outcome/),
  ).toBeVisible();
  expect(savePullRequestState).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "draft",
      body: "Inspect overflow",
      expectedHead: pr.head,
    }),
  );
  expect(setPullRequestWatch).not.toHaveBeenCalled();
});
it("does not claim missing text patches are reviewed and exposes native errors", async () => {
  vi.mocked(readPullRequest).mockImplementation(
    async <T,>(_target: unknown, request: PullRequestRequest): Promise<T> =>
      (request.action === "list"
        ? { items: [pr], nextPage: null }
        : request.action === "detail"
          ? pr
          : {
              items: [
                {
                  path: "logo.png",
                  revision: "blob",
                  additions: 0,
                  deletions: 0,
                  patch: null,
                  patchUnavailable: true,
                },
              ],
              nextPage: null,
            }) as T,
  );
  setup();
  fireEvent.click(await screen.findByText(/logo.png/));
  expect(screen.getByLabelText("Viewed this revision")).toBeDisabled();
  expect(
    screen.getByText(/did not provide a complete text patch/),
  ).toBeVisible();
});
it("stops the repository watch without selecting new Work", async () => {
  state.watch = {
    id: "watch",
    number: 7,
    workId: "work",
    active: true,
    reason: null,
    wakes: 2,
    failures: 0,
  };
  vi.mocked(loadCollaboration).mockResolvedValue({
    work: [],
    conversations: [],
    authors: [],
    teams: [],
    facts: [],
    layout: null,
  });
  vi.mocked(setPullRequestWatch).mockResolvedValue({
    watch: { ...state.watch, active: false },
  });
  setup();
  fireEvent.click(await screen.findByText("PR watch · Active"));
  fireEvent.click(screen.getByRole("button", { name: "Stop PR watch" }));
  await waitFor(() =>
    expect(setPullRequestWatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "stop",
        watchId: "watch",
        repositoryId: "repo",
        number: 7,
      }),
    ),
  );
});
it("preserves unsaved review text when the PR moves to a new head", async () => {
  setup();
  fireEvent.click(await screen.findByText("Draft review · local"));
  fireEvent.change(screen.getByLabelText("Review summary"), {
    target: { value: "Unfinished review of this change" },
  });
  const moved = { ...pr, head: "c".repeat(40) };
  vi.mocked(readPullRequest).mockImplementation(
    async <T,>(_target: unknown, request: PullRequestRequest): Promise<T> =>
      (request.action === "detail"
        ? moved
        : { items: [], nextPage: null }) as T,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh PR and commit" }),
  );
  await screen.findByText(/PR has new commits/);
  expect(screen.getByLabelText("Review summary")).toHaveValue(
    "Unfinished review of this change",
  );
  expect(screen.getByText("Unsaved local draft.")).toBeVisible();
});
