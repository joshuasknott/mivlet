import type { ConnectorSearchItem } from "@arden/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface GitHubPayload {
  id: string | number;
  kind: "repository" | "branch" | "issue" | "pull-request" | "file";
  name: string;
  repository: string;
  description?: string;
  content?: string;
  url?: string;
  updatedAt?: string;
  state?: string;
}

export function normalizeGitHubItem(payload: GitHubPayload): ConnectorSearchItem {
  return {
    id: String(payload.id),
    connectorId: "github",
    title: payload.name,
    kind: payload.kind,
    summary: payload.description ?? `${payload.kind} in ${payload.repository}`,
    provenance: `GitHub · ${payload.repository}`,
    freshness: payload.updatedAt ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.content ? { contentPreview: payload.content } : {}),
    providerMetadata: {
      repository: payload.repository,
      ...(payload.state ? { state: payload.state } : {})
    }
  };
}

export function shapeGitHubSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("github", query, limit);
}

export function prepareGitHubDraftPullRequest(payload: {
  repository: string;
  head: string;
  base: string;
  title: string;
}) {
  return prepareConnectorAction(
    "github",
    "GitHub",
    "github.draft-pull-request",
    { ...payload, targetId: payload.repository },
    "medium",
    "Creates a draft pull request after Arden approval."
  );
}

export function prepareGitHubComment(payload: {
  repository: string;
  targetId: string;
  body: string;
}) {
  return prepareConnectorAction(
    "github",
    "GitHub",
    "github.comment",
    payload,
    "medium",
    "Publishes a comment to the selected GitHub item after Arden approval."
  );
}

export function mapGitHubError(error: ProviderErrorLike) {
  return classifyConnectorError("github", error);
}
