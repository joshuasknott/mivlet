import type {
  CollaborationWorkItem,
  MemoryControlState,
  MemoryRecord,
  WorkOutput,
} from "@fable/protocol";
import { saveRuntimeMemoryState } from "../runtime";

/** Native Memory bounds; the promotion editor enforces the same limits. */
export const MAX_PROMOTED_MEMORY_TITLE = 120;
export const MAX_PROMOTED_MEMORY_VALUE = 2_000;

/** The durable destination under the baseline contract: project work promotes
 * into the owning Project, everything else into the requesting Agent. */
export function memoryPromotionScope(
  work: CollaborationWorkItem,
): MemoryRecord["scope"] {
  return work.projectId
    ? { level: "project", projectId: work.projectId }
    : { level: "agent", agentId: work.agentId };
}

export function memoryPromotionDestination(
  work: CollaborationWorkItem,
): string {
  return work.projectId ? "project memory" : `${work.agentName}'s memory`;
}

/**
 * One deliberately selected conclusion promoted into the baseline Memory
 * interface. `value` is the user-confirmed text, not a machine summary; the
 * record keeps exact run provenance and a fresh id so nothing is resurrected.
 */
export function memoryRecordFromWorkOutput(
  work: CollaborationWorkItem,
  output: WorkOutput,
  value: string,
  now = new Date().toISOString(),
): MemoryRecord {
  const text = value.trim();
  if (!text) throw new Error("Choose the conclusion to save to memory.");
  if (text.length > MAX_PROMOTED_MEMORY_VALUE)
    throw new Error(
      `Memory is limited to ${MAX_PROMOTED_MEMORY_VALUE} characters. Shorten the conclusion before saving.`,
    );
  return {
    id: `memory-${crypto.randomUUID()}`,
    kind: "fact",
    title: (work.userRequest || work.prompt).slice(
      0,
      MAX_PROMOTED_MEMORY_TITLE,
    ),
    value: text,
    source: `${work.agentName} work result`,
    freshness: now,
    approved: true,
    pinned: false,
    scope: memoryPromotionScope(work),
    confidence: 1,
    approvalState: "approved",
    provenance: {
      origin: "run",
      runId: output.runId,
      note: `Saved from ${work.id} output ${output.runId}`,
    },
    runId: output.runId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Sends only the new record: native `save_memory_state` merges by id, so other
 * records, concurrent corrections and forget tombstones are untouched. The
 * disabled flag is the caller's current live value, never a stale snapshot.
 */
export async function promoteWorkOutputToMemory(
  work: CollaborationWorkItem,
  output: WorkOutput,
  value: string,
  state: MemoryControlState,
): Promise<MemoryRecord> {
  const record = memoryRecordFromWorkOutput(work, output, value);
  await saveRuntimeMemoryState({ disabled: state.disabled, records: [record] });
  return record;
}