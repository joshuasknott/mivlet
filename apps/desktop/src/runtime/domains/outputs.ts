import {
  appendOutputRevision,
  createOutputDocument,
  restoreOutputRevision,
  setOutputPinned,
  type AppendOutputRevisionInput,
  type NewOutputInput,
  type OutputDocument,
  type OutputSource,
} from "../../lib/output-revisions";
import { emitOutputPinned } from "../../lib/output-revision-events";
import { activeDataScope, hasTauriRuntime, invoke } from "../bridge";

/** Native output repository DTOs use the same shape as the renderer contract. */
export type RuntimeOutput = OutputDocument;

const previewOutputs = new Map<string, OutputDocument>();

function scopeWorkspace(expectedWorkspaceId?: string) {
  const workspaceId = activeDataScope()?.workspaceId;
  if (!workspaceId)
    throw new Error("A selected workspace is required for outputs.");
  if (expectedWorkspaceId && expectedWorkspaceId !== workspaceId) {
    throw new Error(
      "The selected workspace changed before the output was saved.",
    );
  }
  return workspaceId;
}

function outputKey(workspaceId: string, id: string) {
  return `${workspaceId}:${id}`;
}

function nativeOutput<T>(command: string, args: Record<string, unknown>) {
  return invoke<T>(command, args);
}

export async function listRuntimeOutputs(
  input: {
    conversationId?: string;
    includeUnpinned?: boolean;
    expectedWorkspaceId?: string;
  } = {},
): Promise<RuntimeOutput[]> {
  const workspaceId = scopeWorkspace(input.expectedWorkspaceId);
  if (hasTauriRuntime()) {
    return nativeOutput<RuntimeOutput[]>("output_list", {
      workspaceId,
      input: {
        conversationId: input.conversationId,
        includeUnpinned: input.includeUnpinned ?? true,
      },
    });
  }
  return [...previewOutputs.entries()]
    .filter(
      ([key, output]) =>
        key.startsWith(`${workspaceId}:`) &&
        (!input.conversationId ||
          output.source.conversationId === input.conversationId) &&
        (input.includeUnpinned !== false || output.pinned),
    )
    .map(([, output]) => output);
}

export async function getRuntimeOutput(
  outputId: string,
  expectedWorkspaceId?: string,
): Promise<RuntimeOutput | null> {
  const workspaceId = scopeWorkspace(expectedWorkspaceId);
  if (hasTauriRuntime()) {
    return nativeOutput<RuntimeOutput | null>("output_get", {
      workspaceId,
      outputId,
    });
  }
  return previewOutputs.get(outputKey(workspaceId, outputId)) ?? null;
}

export async function ensureRuntimeOutput(
  input: NewOutputInput,
  expectedWorkspaceId?: string,
): Promise<RuntimeOutput> {
  const workspaceId = scopeWorkspace(expectedWorkspaceId);
  if (hasTauriRuntime()) {
    return nativeOutput<RuntimeOutput>("output_ensure", { workspaceId, input });
  }
  const key = outputKey(workspaceId, input.id);
  const existing = previewOutputs.get(key);
  if (existing) return existing;
  const created = createOutputDocument(input);
  previewOutputs.set(key, created);
  return created;
}

/** Save a bounded response excerpt as a durable, pinned output bookmark. */
export async function saveRuntimeResponseAsPinnedOutput(
  input: Omit<NewOutputInput, "format" | "mimeType" | "author" | "reason"> & {
    format?: Extract<NewOutputInput["format"], "text" | "markdown">;
  },
  expectedWorkspaceId?: string,
): Promise<RuntimeOutput> {
  const output = await ensureRuntimeOutput(
    {
      ...input,
      format: input.format ?? "markdown",
      mimeType: input.format === "text" ? "text/plain" : "text/markdown",
      author: "system",
      reason: "generated",
    },
    expectedWorkspaceId,
  );
  if (output.pinned) return output;
  return setRuntimeOutputPinned(
    output.id,
    true,
    output.source,
    expectedWorkspaceId,
    output.currentRevisionId,
  );
}

export async function appendRuntimeOutputRevision(
  input: AppendOutputRevisionInput,
  expectedWorkspaceId?: string,
): Promise<RuntimeOutput> {
  const workspaceId = scopeWorkspace(expectedWorkspaceId);
  if (hasTauriRuntime()) {
    return nativeOutput<RuntimeOutput>("output_append_revision", {
      workspaceId,
      input,
    });
  }
  const key = outputKey(workspaceId, input.outputId);
  const current = previewOutputs.get(key);
  if (!current) throw new Error("The output is no longer available.");
  const next = appendOutputRevision(current, input);
  previewOutputs.set(key, next);
  return next;
}

export async function restoreRuntimeOutputRevision(
  outputId: string,
  revisionNumber: number,
  expectedRevisionId: string,
  expectedRevisionNumber: number,
  source: OutputSource,
  expectedWorkspaceId?: string,
): Promise<RuntimeOutput> {
  const workspaceId = scopeWorkspace(expectedWorkspaceId);
  if (hasTauriRuntime()) {
    return nativeOutput<RuntimeOutput>("output_restore_revision", {
      workspaceId,
      input: {
        outputId,
        revisionNumber,
        expectedRevisionId,
        expectedRevisionNumber,
        source,
      },
    });
  }
  const key = outputKey(workspaceId, outputId);
  const current = previewOutputs.get(key);
  if (!current) throw new Error("The output is no longer available.");
  const next = restoreOutputRevision(
    current,
    revisionNumber,
    expectedRevisionId,
    expectedRevisionNumber,
    source,
  );
  previewOutputs.set(key, next);
  return next;
}

export async function setRuntimeOutputPinned(
  outputId: string,
  pinned: boolean,
  location?: OutputSource,
  expectedWorkspaceId?: string,
  revisionId?: string,
): Promise<RuntimeOutput> {
  const workspaceId = scopeWorkspace(expectedWorkspaceId);
  if (hasTauriRuntime()) {
    const next = await nativeOutput<RuntimeOutput>("output_set_pin", {
      workspaceId,
      input: { outputId, pinned, location, revisionId },
    });
    emitOutputPinned({ workspaceId, output: next });
    return next;
  }
  const key = outputKey(workspaceId, outputId);
  const current = previewOutputs.get(key);
  if (!current) throw new Error("The output is no longer available.");
  const next = setOutputPinned(
    current,
    pinned,
    new Date().toISOString(),
    location,
    revisionId,
  );
  previewOutputs.set(key, next);
  emitOutputPinned({ workspaceId, output: next });
  return next;
}

export async function exportRuntimeOutput(
  outputId: string,
  destination?: string,
  expectedWorkspaceId?: string,
): Promise<string> {
  const workspaceId = scopeWorkspace(expectedWorkspaceId);
  if (hasTauriRuntime()) {
    return nativeOutput<string>("output_export", {
      workspaceId,
      input: { outputId, destination },
    });
  }
  const current = previewOutputs.get(outputKey(workspaceId, outputId));
  if (!current) throw new Error("The output is no longer available.");
  return (
    current.revisions.find(
      (revision) => revision.id === current.currentRevisionId,
    )?.content ?? ""
  );
}
