import type {
  ConnectorId,
  ConnectorSyncFailure,
  ConnectorSyncFailureKind,
  ConnectorSyncState,
  ConnectorSyncTrigger
} from "@mivlet/protocol";

export type ConnectorCacheClass =
  | "metadata"
  | "searchable-content"
  | "user-owned-data";

export interface ConnectorCachePolicy {
  cacheClass: ConnectorCacheClass;
  persistence: "encrypted-local" | "session-only" | "prohibited";
  workspaceScoped: true;
  exportedWithWorkspace: boolean;
  deletedWithWorkspace: boolean;
  defaultTtlSeconds?: number;
}

export const CONNECTOR_CACHE_POLICIES: Record<ConnectorCacheClass, ConnectorCachePolicy> = {
  metadata: {
    cacheClass: "metadata",
    persistence: "encrypted-local",
    workspaceScoped: true,
    exportedWithWorkspace: true,
    deletedWithWorkspace: true,
    defaultTtlSeconds: 86_400
  },
  "searchable-content": {
    cacheClass: "searchable-content",
    persistence: "encrypted-local",
    workspaceScoped: true,
    exportedWithWorkspace: true,
    deletedWithWorkspace: true,
    defaultTtlSeconds: 3_600
  },
  "user-owned-data": {
    cacheClass: "user-owned-data",
    persistence: "prohibited",
    workspaceScoped: true,
    exportedWithWorkspace: false,
    deletedWithWorkspace: true
  }
};

export interface ConnectorSyncError {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfter?: string;
}

export function initialConnectorSyncState(
  connectorId: ConnectorId,
  workspaceId: string
): ConnectorSyncState {
  assertWorkspaceId(workspaceId);
  return {
    connectorId,
    workspaceId,
    phase: "idle",
    attempt: 0,
    itemsProcessed: 0,
    staleTokenRecovered: false
  };
}

export function startConnectorSync(
  previous: ConnectorSyncState,
  trigger: ConnectorSyncTrigger,
  startedAt: string
): ConnectorSyncState {
  return {
    ...previous,
    phase: "syncing",
    trigger,
    attempt: trigger === "retry" ? previous.attempt + 1 : 1,
    startedAt,
    completedAt: undefined,
    nextRetryAt: undefined,
    itemsProcessed: 0,
    staleTokenRecovered: false,
    failure: undefined
  };
}

export function completeConnectorSync(
  previous: ConnectorSyncState,
  completedAt: string,
  options: {
    itemsProcessed: number;
    cursor?: string;
    partialMessage?: string;
    staleTokenRecovered?: boolean;
  }
): ConnectorSyncState {
  const partial = Boolean(options.partialMessage);
  return {
    ...previous,
    phase: partial ? "partial" : "succeeded",
    completedAt,
    lastSuccessfulAt: partial ? previous.lastSuccessfulAt : completedAt,
    cursor: options.cursor,
    itemsProcessed: Math.max(0, options.itemsProcessed),
    staleTokenRecovered: options.staleTokenRecovered ?? false,
    failure: partial
      ? {
          kind: "partial-sync",
          message: options.partialMessage!,
          retryable: true
        }
      : undefined
  };
}

export function failConnectorSync(
  previous: ConnectorSyncState,
  error: ConnectorSyncError,
  completedAt: string,
  nextRetryAt?: string
): ConnectorSyncState {
  const failure = classifyConnectorSyncError(error);
  return {
    ...previous,
    phase: failure.kind === "cancelled" ? "cancelled" : "failed",
    completedAt,
    nextRetryAt: failure.retryable ? error.retryAfter ?? nextRetryAt : undefined,
    failure
  };
}

export function classifyConnectorSyncError(error: ConnectorSyncError): ConnectorSyncFailure {
  const kind = syncFailureKind(error.code);
  return {
    kind,
    message: error.message,
    retryable:
      kind === "provider-unavailable" || kind === "rate-limited" || kind === "partial-sync"
        ? error.retryable !== false
        : false,
    retryAfter: error.retryAfter
  };
}

function syncFailureKind(code: string): ConnectorSyncFailureKind {
  switch (code) {
    case "needs-auth":
    case "auth-required":
    case "configuration-required":
    case "token-expired":
    case "refresh-rejected":
      return "auth-required";
    case "permission-denied":
      return "permission-denied";
    case "rate-limited":
      return "rate-limited";
    case "cancelled":
      return "cancelled";
    case "partial-sync":
      return "partial-sync";
    default:
      return "provider-unavailable";
  }
}

export function assertWorkspaceId(workspaceId: string): void {
  if (
    workspaceId.length < 1 ||
    workspaceId.length > 128 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(workspaceId)
  ) {
    throw new Error("Connector sync requires a valid local workspace id.");
  }
}
