import { toRuntimeError } from "../errors";
import type { ExecutionAttempt, RuntimeSnapshot } from "@mivlet/protocol";
import { hasTauriRuntime, invoke, activeDataScope } from "../bridge";

export async function loadRuntimeSnapshot(
  workspaceId = activeDataScope()?.workspaceId,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;

  try {
    return await invoke<RuntimeSnapshot | null>("load_runtime_snapshot", {
      workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeSnapshot(
  snapshot: RuntimeSnapshot,
  workspaceId = activeDataScope()?.workspaceId,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;

  try {
    return await invoke<RuntimeSnapshot>("save_runtime_snapshot", {
      snapshot,
      workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeExecutionAttempt(
  attempt: ExecutionAttempt,
  expectedWorkspaceId?: string,
) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  if (expectedWorkspaceId && scope.workspaceId !== expectedWorkspaceId) {
    throw new Error(
      "The selected workspace changed before the execution attempt was saved.",
    );
  }
  try {
    return await invoke<ExecutionAttempt>("save_execution_attempt", {
      attempt,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeExecutionAttempts() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ExecutionAttempt[]>("list_execution_attempts", scope);
  } catch {
    return null;
  }
}

export async function recoverRuntimeExecutionAttempts(recoveredAt: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ExecutionAttempt[]>(
      "recover_interrupted_execution_attempts",
      { recoveredAt, ...scope },
    );
  } catch {
    return null;
  }
}
