import {
  assembleContext,
  chunkSourceText,
  isLiveSource,
  retrieve,
} from "@mivlet/knowledge";
import type {
  KnowledgeSource,
  MemoryRecord,
  PreparedExecutionContext,
} from "@mivlet/protocol";
import {
  knowledgeScopeForRun,
  privateRunAudience,
  recordsVisibleToRunAudience,
  selectMemoryForRun,
  sourceAllowedByConnections,
  withPreviewPrivateAuthority,
  type KnowledgeRunContext,
} from "../../lib/agent-run";
import { hasTauriRuntime } from "../../lib/persistence";
import { listRuntimeContextSummaries } from "../../runtime/domains/memory";
import type { ShellRuntime } from "./types";

function createExecutionAttemptId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `run-${uuid}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Build context from the current account metadata; native custody remains authoritative. */
export function createWorkspaceContext({
  connectorAccounts,
  workspaceKnowledgeSources,
  managedMemoryRecords,
  memoryDisabled,
  accountWorkspaceStatus,
}: {
  connectorAccounts: ShellRuntime["connectorAccounts"];
  workspaceKnowledgeSources: KnowledgeSource[];
  managedMemoryRecords: MemoryRecord[];
  memoryDisabled: boolean;
  accountWorkspaceStatus: ShellRuntime["accountWorkspaceStatus"];
}) {
  const connectionIsAuthorized = (
    connectorId: string,
    _account?: string,
    connectionId?: string,
  ) => {
    if (connectorId === "local-files") return true;
    if (!connectionId) return false;
    if (!hasTauriRuntime()) return false;
    const connection = connectorAccounts[connectorId]?.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    return Boolean(
      connection &&
      connection.lifecycle === "authorized" &&
      connection.authorizationState === "authorized" &&
      connection.credentialState === "available" &&
      connection.healthState !== "unhealthy" &&
      connection.healthState !== "offline",
    );
  };

  const sourceIsAuthorized = (source: KnowledgeSource) => {
    if (
      source.disabled ||
      source.deletedAt ||
      source.status === "stale" ||
      source.status === "error"
    )
      return false;
    return connectionIsAuthorized(
      source.connectorId,
      source.account,
      source.connectionId,
    );
  };

  const knowledgeRetrievalSources = (
    sources: readonly KnowledgeSource[] = workspaceKnowledgeSources,
    context?: KnowledgeRunContext,
  ) =>
    sources
      // Only live (non-disabled), authorized, connected-connector sources can
      // enter retrieval. Stale/error statuses are additionally excluded by the
      // retrieval filter; we re-check live here so a
      // disabled source is never even chunked.
      .filter(
        (source) =>
          isLiveSource(source) &&
          sourceIsAuthorized(source) &&
          sourceAllowedByConnections(source, context) &&
          !context?.excludedKnowledgeSourceIds?.includes(source.id) &&
          (!context?.allowedConnectorIds ||
            source.connectorId === "local-files" ||
            context.allowedConnectorIds.includes(source.connectorId)) &&
          (!context?.allowedKnowledgeSourceIds ||
            context.allowedKnowledgeSourceIds.includes(source.id)),
      )
      .map((source) => ({
        source,
        chunks: chunkSourceText(source.contentPreview ?? "", {
          sourceId: source.id,
          mimeType: source.providerMetadata?.mimeType,
        }),
      }))
      .filter((record) => record.chunks.length > 0);

  const assembleConversationContext = async (
    query: string,
    context?: KnowledgeRunContext,
  ): Promise<PreparedExecutionContext> => {
    const attemptId = createExecutionAttemptId();
    const assembledAt = new Date().toISOString();
    const scope = knowledgeScopeForRun(context?.threadId);
    const audience = privateRunAudience(accountWorkspaceStatus);
    const selectedMemory = selectMemoryForRun(managedMemoryRecords);
    // Native records must already carry canonical ownership from migration.
    // Browser preview has no native store, so its deliberate fixtures receive
    // explicit private ownership before the same fail-closed filter is applied.
    const governedSources = hasTauriRuntime()
      ? workspaceKnowledgeSources
      : withPreviewPrivateAuthority(workspaceKnowledgeSources, audience);
    const governedMemory = hasTauriRuntime()
      ? selectedMemory
      : withPreviewPrivateAuthority(selectedMemory, audience);
    const visibleSources = recordsVisibleToRunAudience(
      governedSources,
      audience,
    );
    const visibleMemory = recordsVisibleToRunAudience(governedMemory, audience);
    // Durable derived summaries for this exact conversation. They are account-
    // scoped natively and only enter the prefix as untrusted prior evidence.
    const summaries =
      hasTauriRuntime() && context?.threadId && !context.excludeDerivedSummaries
        ? ((await listRuntimeContextSummaries(context.threadId)) ?? [])
        : [];
    const result = await retrieve(
      knowledgeRetrievalSources(visibleSources, context),
      {
        query,
        scope,
        audience,
        limit: 8,
        budgetChars: 6_000,
      },
    );
    const assembled = assembleContext({
      attemptId,
      assembledAt,
      scope,
      audience,
      // Only live memories enter context: forgotten/disabled records are
      // excluded by isLiveMemory. Memory-disabled (the workspace-level kill
      // switch) excludes everything.
      memory:
        memoryDisabled || context?.excludePrivateMemory ? [] : visibleMemory,
      summaries,
      citations: result.citations,
      authorization: {
        isSourceAuthorized: connectionIsAuthorized,
      },
    });
    return Object.freeze({
      systemPrefix: assembled.systemPrefix,
      receipt: assembled.receipt,
    });
  };

  return { assembleConversationContext };
}
