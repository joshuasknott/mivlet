import { Stack } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { KnowledgePanel } from "../KnowledgePanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Knowledge page. Surfaces indexed sources and the durable memory
 * editor with the shared page chrome. Content is driven by the runtime hook.
 */
export function KnowledgePage({ runtime }: { runtime: ShellRuntime }) {
  return (
    <>
    <PageHeader
      icon={Stack}
      title="Knowledge"
      description="Indexed sources and durable memory. Pin context, approve trusted items into memory, and export everything."
      meta={`${runtime.workspaceKnowledgeSources.length} sources · ${runtime.managedMemoryRecords.length} memory`}
    />
    <KnowledgePanel
      sources={runtime.workspaceKnowledgeSources}
      memory={runtime.managedMemoryRecords}
      memoryDisabled={runtime.memoryDisabled}
      editingMemoryId={runtime.editingMemoryId}
      editingMemoryDraft={runtime.editingMemoryDraft}
      memoryExportText={runtime.memoryExportText}
      memoryStatus={runtime.memoryStatus}
      pinnedSourceIds={runtime.pinnedSourceIds}
      onTogglePin={runtime.toggleSourcePin}
      onPromoteSource={runtime.promoteSourceToMemory}
      onStartMemoryEdit={runtime.startMemoryEdit}
      onUpdateMemoryDraft={runtime.setEditingMemoryDraft}
      onSaveMemoryEdit={runtime.saveMemoryEdit}
      onCancelMemoryEdit={runtime.cancelMemoryEdit}
      onForgetMemory={runtime.forgetMemory}
      onToggleMemoryPin={runtime.toggleMemoryPin}
      onToggleMemoryDisabled={runtime.toggleMemoryDisabled}
      onExportMemory={runtime.exportMemory}
    />
    </>
  );
}
