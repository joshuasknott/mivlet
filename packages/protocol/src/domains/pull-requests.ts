/** Native GitHub projections. Credentials and native paths are never included. */
export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: string;
  headBranch: string;
  base: string;
  baseBranch: string;
  mergeable: boolean | null;
  author: string;
  updatedAt: string;
}
export interface PullRequestCommentDraft {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}
export interface PullRequestRequest {
  repositoryId: string;
  action: string;
  number?: number;
  remote?: string;
  expectedHead?: string;
  headBranch?: string;
  baseSha?: string;
  baseBranch?: string;
  nextHead?: string;
  title?: string;
  event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";
  reviewId?: number;
  body?: string;
  comments?: PullRequestCommentDraft[];
  path?: string;
  revision?: string;
  viewed?: boolean;
  page?: number;
  pageSize?: number;
  workId?: string;
  workGeneration?: number;
  watchId?: string;
}
export interface PullRequestFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  revision: string;
  patchUnavailable: boolean;
}
export interface PullRequestActivity {
  id: number;
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
  body?: string;
  path?: string;
  line?: number;
  user?: { login: string };
}
export interface PullRequestPage<T> {
  items: T[];
  nextPage: number | null;
  head?: string;
  limitReached?: boolean;
}
export interface PullRequestLocalState {
  review: {
    head: string;
    body: string;
    comments: PullRequestCommentDraft[];
    viewed: Record<string, string>;
  } | null;
  pending: { request: PullRequestRequest; startedAt: string } | null;
  watch: {
    id: string;
    number: number;
    workId: string;
    active: boolean;
    reason: string | null;
    wakes: number;
    failures: number;
  } | null;
}
