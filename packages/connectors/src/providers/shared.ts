import type {
  ApprovalRiskLevel,
  ConnectorActionKind,
  ConnectorActionRequest,
  ConnectorError,
  ConnectorErrorCode,
  ConnectorImportRequest,
  ConnectorImportResult,
  ConnectorSearchItem,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  FirstWaveConnectorId,
  KnowledgeSource
} from "@arden/protocol";
import { connectorSearchFixtures } from "../fixtures";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARACTERS = 500;

export interface ProviderErrorLike {
  status?: number;
  code?: string;
  retryAfter?: string;
}

export function shapeConnectorSearchRequest(
  connectorId: FirstWaveConnectorId,
  query: string,
  limit = DEFAULT_LIMIT,
  cursor?: string
): ConnectorSearchRequest {
  return {
    connectorId,
    query: Array.from(query.trim()).slice(0, MAX_QUERY_CHARACTERS).join(""),
    limit: normalizeLimit(limit),
    ...(cursor ? { cursor } : {})
  };
}

export function searchConnectorFixtures(
  request: ConnectorSearchRequest,
  searchedAt = new Date().toISOString()
): ConnectorSearchResult {
  const shapedRequest = shapeConnectorSearchRequest(
    request.connectorId,
    request.query,
    request.limit,
    request.cursor
  );
  const query = shapedRequest.query.toLocaleLowerCase();
  const items = connectorSearchFixtures[shapedRequest.connectorId]
    .filter((item) => {
      if (!query) {
        return true;
      }
      return [item.title, item.summary, item.contentPreview ?? "", item.provenance]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    })
    .slice(0, shapedRequest.limit);

  return {
    connectorId: shapedRequest.connectorId,
    query: shapedRequest.query,
    items,
    source: "fixture",
    searchedAt
  };
}

export function importConnectorSearchItem(
  request: ConnectorImportRequest
): ConnectorImportResult {
  if (request.item.connectorId !== request.connectorId) {
    throw new Error("Connector import item does not match the selected provider.");
  }
  if (
    request.connectorId === "google-drive" &&
    request.item.providerMetadata.selected !== "true"
  ) {
    throw new Error("Google Drive imports require an explicitly selected file.");
  }
  if (!request.importedAt.trim()) {
    throw new Error("Connector imports require an import time.");
  }

  const source: KnowledgeSource = {
    id: `connector-${request.connectorId}-${safeId(request.item.id)}`,
    title: request.item.title,
    kind: toKnowledgeSourceKind(request.item.kind),
    connectorId: request.connectorId,
    provenance: request.item.provenance,
    freshness: request.item.freshness,
    pinned: false,
    trust: "untrusted",
    contentPreview: request.item.contentPreview ?? request.item.summary,
    importedAt: request.importedAt,
    origin: "connector-import",
    providerMetadata: { ...request.item.providerMetadata }
  };

  return { source, imported: true };
}

function toKnowledgeSourceKind(kind: ConnectorSearchItem["kind"]): KnowledgeSource["kind"] {
  if (
    kind === "repository" ||
    kind === "branch" ||
    kind === "project" ||
    kind === "database" ||
    kind === "conversation" ||
    kind === "calendar"
  ) {
    return "folder";
  }
  if (kind === "deployment") {
    return "web";
  }
  return "document";
}

export function classifyConnectorError(
  connectorId: FirstWaveConnectorId,
  error: ProviderErrorLike
): ConnectorError {
  const normalizedCode = (error.code ?? "").toLocaleLowerCase();
  let code: ConnectorErrorCode = "unknown";
  let retryable = false;

  if (error.status === 401) {
    code = normalizedCode.includes("expired") ? "expired-auth" : "needs-auth";
  } else if (error.status === 403) {
    code = "permission-denied";
  } else if (error.status === 404) {
    code = "not-found";
  } else if (error.status === 429) {
    code = "rate-limited";
    retryable = true;
  } else if ((error.status ?? 0) >= 500) {
    code = "provider-unavailable";
    retryable = true;
  } else if (error.status === 400) {
    code = "invalid-request";
  } else if (
    normalizedCode.includes("expired") &&
    (normalizedCode.includes("auth") || normalizedCode.includes("token"))
  ) {
    code = "expired-auth";
  } else if (normalizedCode.includes("auth") || normalizedCode.includes("token")) {
    code = "needs-auth";
  } else if (normalizedCode.includes("permission") || normalizedCode.includes("scope")) {
    code = "permission-denied";
  } else if (normalizedCode.includes("not_found")) {
    code = "not-found";
  } else if (normalizedCode.includes("rate")) {
    code = "rate-limited";
    retryable = true;
  } else if (normalizedCode.includes("unavailable")) {
    code = "provider-unavailable";
    retryable = true;
  } else if (normalizedCode.includes("invalid")) {
    code = "invalid-request";
  }

  return {
    connectorId,
    code,
    message: connectorErrorMessage(code),
    retryable,
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {})
  };
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function connectorErrorMessage(code: ConnectorErrorCode) {
  const messages: Record<ConnectorErrorCode, string> = {
    "configuration-required": "This connector needs provider configuration before it can run.",
    "needs-auth": "Connect this provider before trying again.",
    "expired-auth": "The provider authorization expired. Reconnect and try again.",
    "permission-denied": "The provider did not grant the required permission.",
    "rate-limited": "The provider rate limit was reached. Try again later.",
    "provider-unavailable": "The provider is temporarily unavailable.",
    "not-found": "The requested provider item was not found.",
    "invalid-request": "The connector request is invalid.",
    "approval-required": "Approve this action before it can execute.",
    unknown: "The connector request failed."
  };
  return messages[code];
}

export function prepareConnectorAction(
  connectorId: FirstWaveConnectorId,
  service: string,
  action: ConnectorActionKind,
  payload: Record<string, string>,
  riskLevel: ApprovalRiskLevel,
  consequence: string,
  requestedAt = new Date().toISOString()
): ConnectorActionRequest {
  const target = payload.targetId ?? payload.channelId ?? payload.calendarId ?? "selection";
  const id = `${connectorId}-${action.replaceAll(".", "-")}-${safeId(target)}`;
  const highRisk = riskLevel === "high" || riskLevel === "critical";

  return {
    id,
    connectorId,
    action,
    payload: { ...payload },
    approval: {
      id,
      service,
      action: actionLabel(action),
      mode: highRisk ? "full-access" : "trusted-scope",
      riskLevel,
      dataUsed: Object.keys(payload),
      consequence,
      requestedAt,
      decisions: ["once", "session", "rule", "modify", "deny"],
      ...(highRisk ? { confirmationPhrase: confirmationPhrase(action) } : {})
    }
  };
}

function safeId(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "selection";
}

function actionLabel(action: ConnectorActionKind) {
  return action
    .split(".")
    .at(-1)!
    .split("-")
    .map((word) => word[0].toLocaleUpperCase() + word.slice(1))
    .join(" ");
}

function confirmationPhrase(action: ConnectorActionKind) {
  if (action === "gmail.send") {
    return "send email";
  }
  if (action === "slack.post") {
    return "post message";
  }
  if (action === "vercel.promote") {
    return "promote deployment";
  }
  if (action === "vercel.rollback") {
    return "rollback deployment";
  }
  return "confirm external write";
}
