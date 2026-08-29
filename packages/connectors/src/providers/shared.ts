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
  SupportedConnectorId,
  KnowledgeSource
} from "@fable/protocol";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARACTERS = 500;

export interface ProviderErrorLike {
  status?: number;
  code?: string;
  retryAfter?: string;
}

export function shapeConnectorSearchRequest(
  connectorId: SupportedConnectorId,
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
    ...(request.item.connectionId ? { connectionId: request.item.connectionId } : {}),
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
  connectorId: SupportedConnectorId,
  error: ProviderErrorLike
): ConnectorError {
  const normalizedCode = (error.code ?? "").toLocaleLowerCase();
  let code: ConnectorErrorCode = "unknown";
  let retryable = false;

  if (
    error.status === 503 ||
    normalizedCode.includes("configuration") ||
    normalizedCode.includes("broker")
  ) {
    code = "configuration-required";
  } else if (error.status === 401) {
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
  connectorId: SupportedConnectorId,
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
      // External writes always need a fresh decision for the exact action.
      decisions: ["once", "modify", "deny"],
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
  if (action === "google-drive.share-file") {
    return "share drive file";
  }
  if (action === "google-drive.delete-file") {
    return "delete drive file";
  }
  if (action === "google-calendar.delete-event") {
    return "delete calendar event";
  }
  if (action === "google-calendar.cancel-event") {
    return "cancel calendar event";
  }
  if (action === "slack.post") {
    return "post message";
  }
  if (action === "slack.reply") return "post message";
  if (action === "slack.edit" || action === "slack.react-add" || action === "slack.react-remove") return "change slack content";
  if (action === "slack.delete") return "delete slack message";
  if (action === "notion.delete-block") return "delete notion block";
  if (action === "vercel.promote") {
    return "promote deployment";
  }
  if (action === "vercel.rollback") {
    return "rollback deployment";
  }
  return "confirm external write";
}
