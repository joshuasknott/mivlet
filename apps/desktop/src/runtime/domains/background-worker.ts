import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

export interface BackgroundWorkerStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  protocol: number;
  version: string;
  processId: number | null;
  activeWork: number;
}

export async function backgroundWorkerStatus(): Promise<BackgroundWorkerStatus> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview") {
    return {
      supported: false,
      enabled: false,
      running: false,
      protocol: 1,
      version: "",
      processId: null,
      activeWork: 0,
    };
  }
  try {
    return await adapter.invoke<BackgroundWorkerStatus>(
      "background_worker_status",
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function controlBackgroundWorker(
  action: "start" | "stop" | "restart",
): Promise<BackgroundWorkerStatus> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview")
    throw new Error("Background execution requires the installed Windows app.");
  try {
    return await adapter.invoke<BackgroundWorkerStatus>(
      "background_worker_control",
      { action },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}
