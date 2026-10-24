import { toRuntimeError } from "../errors";
import type { LocalTextFileCandidate } from "@mivlet/connectors/local-files";
import type {
  ContextSummaryRecord,
  KnowledgeSearchResponse,
  KnowledgeSource,
  LocalFileImport,
  LocalKnowledgeRefreshResponse,
  RefreshLocalKnowledgeSourceRequest,
  MemoryControlState,
} from "@mivlet/protocol";
import {
  hasTauriRuntime,
  invoke,
  invokeNative,
  activeDataScope,
} from "../bridge";

export async function loadRuntimeImportedKnowledgeSources() {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<LocalFileImport[]>(
    "list_imported_knowledge_sources",
    scope,
  ).catch(() => null);
}

export async function importRuntimeLocalKnowledgeSource(
  candidate: LocalTextFileCandidate,
) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<LocalFileImport>("import_local_knowledge_source", {
    candidate,
    ...scope,
  });
}

export async function refreshRuntimeLocalKnowledgeSource(
  request: RefreshLocalKnowledgeSourceRequest,
) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<LocalKnowledgeRefreshResponse>(
    "refresh_local_knowledge_source",
    {
      request,
      ...scope,
    },
  );
}

export async function searchRuntimeKnowledgeSources(
  query: string,
  sources: KnowledgeSource[],
  limit?: number,
) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<KnowledgeSearchResponse>("search_knowledge_sources", {
    query,
    sources,
    limit,
    ...scope,
  }).catch(() => null);
}

export async function loadRuntimeMemoryState() {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<MemoryControlState>("list_memory_state", scope).catch(
    () => null,
  );
}

export async function saveRuntimeMemoryState(state: MemoryControlState) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<MemoryControlState>("save_memory_state", {
    state,
    ...scope,
  });
}

export async function correctRuntimeMemoryRecord(correction: {
  id: string;
  title: string;
  value: string;
  expectedUpdatedAt?: string;
}) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime())
    throw new Error("Memory correction requires the desktop app.");
  try {
    return await invoke<MemoryControlState>("correct_memory_record", {
      correction,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function changeRuntimeMemoryRecord(change: {
  id: string;
  state: "enabled" | "disabled" | "forgotten";
  expectedUpdatedAt?: string;
}) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime())
    throw new Error("Memory controls require the desktop app.");
  try {
    return await invoke<MemoryControlState>("change_memory_record_state", {
      change,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function exportRuntimeMemoryState(_state: MemoryControlState) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<string>("export_memory_state", scope);
}

/**
 * Live durable summaries for one conversation. Browser preview has no native
 * account store, so compaction stays unavailable there instead of inventing a
 * second summary store.
 */
export async function listRuntimeContextSummaries(threadId: string) {
  const scope = activeDataScope();
  if (!scope || !threadId) return null;
  return invokeNative<ContextSummaryRecord[]>("list_context_summaries", {
    threadId,
    ...scope,
  }).catch(() => null);
}

/** Persist one incremental summary revision before it may enter a turn. */
export async function saveRuntimeContextSummary(summary: ContextSummaryRecord) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<ContextSummaryRecord>("save_context_summary", {
    summary,
    ...scope,
  });
}
