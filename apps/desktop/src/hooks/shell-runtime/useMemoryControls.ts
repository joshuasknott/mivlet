import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { exportMemories, isLiveMemory } from "@mivlet/knowledge";
import type { MemoryControlState, MemoryRecord } from "@mivlet/protocol";
import {
  changeRuntimeMemoryRecord,
  correctRuntimeMemoryRecord,
  exportRuntimeMemoryState,
  loadRuntimeMemoryState,
  saveRuntimeMemoryState,
} from "../../runtime/domains/memory";

/** Memory controls keep the shell's hydration owner and exact scope fence. */
export function useMemoryControls({
  memoryDisabled,
  managedMemoryRecords,
  memoryState,
  connectorScopeRef,
  setMemoryDisabled,
  setManagedMemoryRecords,
  setMemoryStatus,
  setMemoryExportText,
}: {
  memoryDisabled: boolean;
  managedMemoryRecords: MemoryRecord[];
  memoryState: MemoryControlState;
  connectorScopeRef: RefObject<number>;
  setMemoryDisabled: Dispatch<SetStateAction<boolean>>;
  setManagedMemoryRecords: Dispatch<SetStateAction<MemoryRecord[]>>;
  setMemoryStatus: Dispatch<SetStateAction<string>>;
  setMemoryExportText: Dispatch<SetStateAction<string>>;
}) {
  const commitMemoryState = (state: MemoryControlState, status: string) => {
    // Capture the pre-change state so a native save failure rolls back the
    // optimistic update instead of leaving a phantom record in the UI.
    const previousDisabled = memoryDisabled;
    const previousRecords = managedMemoryRecords;
    const generation = connectorScopeRef.current;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(
      state.records.filter((record) => !record.forgottenAt),
    );
    setMemoryStatus("Saving memory…");

    return saveRuntimeMemoryState(state)
      .then((runtimeState) => {
        if (!runtimeState || connectorScopeRef.current !== generation) {
          return;
        }

        setMemoryDisabled(runtimeState.disabled);
        setManagedMemoryRecords(runtimeState.records);
        setMemoryStatus(status);
      })
      .catch(async (error) => {
        const current = await loadRuntimeMemoryState().catch(() => null);
        if (connectorScopeRef.current !== generation) return;
        // A concurrent correction may be newer than this optimistic snapshot.
        setMemoryDisabled(current?.disabled ?? previousDisabled);
        setManagedMemoryRecords(current?.records ?? previousRecords);
        setMemoryStatus(
          error instanceof Error
            ? error.message
            : "Mivlet could not save memory state.",
        );
      });
  };

  // Send only the changed record; the native transaction merges other memories
  // and rejects stale revisions and forgotten-record resurrection.
  const saveMemoryRecord = async (record: MemoryRecord) => {
    const generation = connectorScopeRef.current;
    const state = await saveRuntimeMemoryState({
      disabled: memoryDisabled,
      records: [record],
    });
    if (!state) throw new Error("Saving memories requires the desktop app.");
    if (connectorScopeRef.current !== generation) return;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus("Memory saved.");
  };
  const refreshMemories = useCallback(async () => {
    const generation = connectorScopeRef.current;
    const state = await loadRuntimeMemoryState();
    if (state && connectorScopeRef.current === generation) {
      setMemoryDisabled(state.disabled);
      setManagedMemoryRecords(state.records);
    }
  }, []);
  const addChatMemory = async (
    threadId: string,
    title: string,
    value: string,
  ) => {
    if (!threadId || !title.trim() || !value.trim())
      throw new Error("Enter a title and memory for this chat.");
    if (title.trim().length > 120 || value.trim().length > 2000)
      throw new Error(
        "Keep the title under 120 characters and memory under 2,000 characters.",
      );
    const now = new Date().toISOString();
    await saveMemoryRecord({
      id: `memory-${crypto.randomUUID()}`,
      kind: "fact",
      title: title.trim(),
      value: value.trim(),
      source: "Added by you",
      freshness: now,
      approved: true,
      approvalState: "approved",
      pinned: false,
      scope: { level: "thread", threadId },
      provenance: { origin: "manual", note: "Saved explicitly in this chat" },
      confidence: 1,
      createdAt: now,
      updatedAt: now,
    });
  };
  const approveMemory = async (recordId: string) => {
    const record = managedMemoryRecords.find(
      (item) =>
        item.id === recordId &&
        !item.forgottenAt &&
        item.approvalState === "suggested",
    );
    if (!record) throw new Error("That suggestion is no longer available.");
    await saveMemoryRecord({
      ...record,
      approved: true,
      approvalState: "approved",
      confidence: 1,
    });
  };

  const changeMemory = async (
    recordId: string,
    change: "enabled" | "disabled" | "forgotten",
  ) => {
    const record = managedMemoryRecords.find(
      (item) => item.id === recordId && !item.forgottenAt,
    );
    if (!record) throw new Error("That memory is no longer available.");
    const generation = connectorScopeRef.current;
    const state = await changeRuntimeMemoryRecord({
      id: recordId,
      state: change,
      expectedUpdatedAt: record.updatedAt,
    });
    if (connectorScopeRef.current !== generation) return;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus(
      change === "forgotten"
        ? "Memory forgotten."
        : change === "disabled"
          ? "Memory disabled."
          : "Memory enabled.",
    );
  };
  const forgetMemory = (recordId: string) =>
    changeMemory(recordId, "forgotten");

  const correctMemory = async (
    recordId: string,
    title: string,
    value: string,
    expectedUpdatedAt?: string,
  ) => {
    const generation = connectorScopeRef.current;
    const state = await correctRuntimeMemoryRecord({
      id: recordId,
      title,
      value,
      expectedUpdatedAt,
    });
    if (connectorScopeRef.current !== generation) return;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus("Memory corrected.");
  };

  /**
   * Toggle a single memory's disabled state. A disabled memory is excluded from
   * retrieval, context, and export (like a forgotten one) but stays visible in
   * the management view and can be re-enabled — no record duplication. Pinning
   * is dropped while disabled so it cannot bypass the exclusion via pinned
   * context.
   */
  const toggleMemoryRecordDisabled = (recordId: string) =>
    changeMemory(
      recordId,
      managedMemoryRecords.find((record) => record.id === recordId)?.disabled
        ? "enabled"
        : "disabled",
    );

  const toggleMemoryPin = (recordId: string) => {
    const target = managedMemoryRecords.find(
      (record) => record.id === recordId,
    );
    if (!target) return;
    // Pinning must not bypass exclusion: a disabled or forgotten memory cannot
    // be pinned. Unpinning a currently-pinned record is always allowed so a
    // stale pin can be cleared.
    if (!target.pinned && !isLiveMemory(target)) {
      setMemoryStatus("Disabled or forgotten memories cannot be pinned.");
      return;
    }
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId ? { ...record, pinned: !record.pinned } : record,
    );
    const changed = nextRecords.find((record) => record.id === recordId);
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      changed?.pinned ? "Memory pinned." : "Memory unpinned.",
    );
  };

  const toggleMemoryDisabled = () => {
    return commitMemoryState(
      { disabled: !memoryDisabled, records: managedMemoryRecords },
      memoryDisabled ? "Memory enabled." : "Memory disabled.",
    );
  };

  const exportMemory = async () => {
    try {
      // Live memories only: forgotten/disabled records are excluded by
      // `exportMemories`. The native export is authoritative when present; the
      // fallback re-applies the same live-only filter so secrets never ride
      // along on a forgotten record's payload and disabled records never leak.
      const liveFallback = exportMemories(memoryState.records);
      const exported =
        (await exportRuntimeMemoryState(memoryState)) ?? liveFallback;
      setMemoryExportText(exported);
      setMemoryStatus("Memory export ready.");
    } catch (error) {
      setMemoryStatus(
        error instanceof Error
          ? error.message
          : "Mivlet could not export memory.",
      );
    }
  };

  return {
    toggleMemoryPin,
    forgetMemory,
    addChatMemory,
    approveMemory,
    refreshMemories,
    correctMemory,
    toggleMemoryRecordDisabled,
    toggleMemoryDisabled,
    exportMemory,
  };
}
