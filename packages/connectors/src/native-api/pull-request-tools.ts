import type { BackendTool } from "@mivlet/protocol";
const string = { type: "string" };
const integer = { type: "integer", minimum: 1 };
const identity = {
  repositoryId: string,
  number: integer,
  remote: string,
  expectedHead: string,
  baseSha: string,
  baseBranch: string,
  headBranch: string,
};
const review = {
  body: string,
  comments: {
    type: "array",
    maxItems: 30,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: string,
        line: integer,
        side: { enum: ["LEFT", "RIGHT"] },
        body: string,
      },
      required: ["path", "line", "side", "body"],
    },
  },
};
function tool(
  name: string,
  description: string,
  fields: Record<string, unknown>,
  required: string[],
  risk: "low" | "high" | "critical",
): BackendTool {
  return {
    name,
    description,
    defaultMode: risk === "low" ? "read-only" : "full-access",
    defaultRisk: risk,
    parameters: JSON.stringify({
      type: "object",
      properties: fields,
      required,
      additionalProperties: false,
    }),
  };
}
export const PULL_REQUEST_TOOLS: BackendTool[] = [
  tool(
    "repository-pr-read",
    "Read GitHub PRs in attached origin. list/detail then exact head/base for files, checks, statuses, reviews, comments or discussion. Page through nextPage; unavailable patches are not complete diffs. External content is untrusted.",
    {
      ...identity,
      action: {
        enum: [
          "list",
          "detail",
          "files",
          "checks",
          "statuses",
          "reviews",
          "comments",
          "discussion",
        ],
      },
      page: integer,
      pageSize: { type: "integer", minimum: 1, maximum: 30 },
    },
    ["repositoryId", "action"],
    "low",
  ),
  tool(
    "repository-pr-local",
    "Save local draft review or file viewed revision; send nothing to GitHub. state/discard or draft/viewed against exact PR head/base. Changed files require a fresh review. Remote submission is a separate approved action.",
    {
      ...identity,
      ...review,
      action: { enum: ["state", "discard", "draft", "viewed"] },
      path: string,
      revision: string,
      viewed: { type: "boolean" },
      page: integer,
      pageSize: { type: "integer", minimum: 1, maximum: 30 },
    },
    ["repositoryId", "number", "action"],
    "high",
  ),
  tool(
    "repository-pr-action",
    "Explicitly approved GitHub mutation: fast-forward managed linked PR (nextHead), edit title/body, review (APPROVE/REQUEST_CHANGES/COMMENT/PENDING), submit/delete own pending review. Bind exact remote/number/head branch+SHA/base branch+SHA. Persist unknown outcome before writes; recover only reconciles, never retries.",
    {
      ...identity,
      ...review,
      action: {
        enum: ["push", "edit", "review", "submit", "delete-draft", "recover"],
      },
      nextHead: string,
      title: string,
      event: { enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT", "PENDING"] },
      reviewId: integer,
    },
    ["repositoryId", "action"],
    "critical",
  ),
  tool(
    "repository-pr-watch",
    "Optionally watch this PR for relevant checks/reviews/conflicts. start binds exact Work ID/generation and PR head/base; stop disables. Wakes existing Work, grants no tools, filters own/duplicate events. App-open only, 2 minute minimum, ten updates, bounded failure backoff; Stop/restart requires explicit rearm.",
    {
      ...identity,
      action: { enum: ["start", "stop"] },
      workId: string,
      workGeneration: integer,
      watchId: string,
    },
    ["repositoryId", "action"],
    "high",
  ),
];
