import type {
  CollaborationWorkItem,
  MemoryControlState,
  MemoryRecord,
  WorkOutput,
} from "@fable/protocol";
import { saveRuntimeMemoryState } from "../runtime";

/** One saved result promoted into the baseline Memory interface with exact
 * work provenance. Explicit user action only; nothing is promoted on
 * completion or close alone. */
export function memoryRecordFromWorkOutput(
  work: CollaborationWorkItem,
  output: WorkOutput,
  now = new Date().toISOString(),
): MemoryRecord {
  return {
    id: `memory-${crypto.randomUUID()}`,
    kind: "fact",
    title: (work.userRequest || work.prompt).slice(0, 120),
    value: output.text.slice(0, 4000),
    source: `${work.agentName} work result`,
    freshness: now,
    approved: true,
    pinned: false,
    scope: { level: "work", workId: work.id },
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

export async function promoteWorkOutputToMemory(
  work: CollaborationWorkItem,
  output: WorkOutput,
  state: MemoryControlState,
): Promise<MemoryRecord> {
  const record = memoryRecordFromWorkOutput(work, output);
  await saveRuntimeMemoryState({
    disabled: state.disabled,
    records: [
      ...state.records.filter((existing) => !existing.forgottenAt),
      record,
    ],
  });
  return record;
}