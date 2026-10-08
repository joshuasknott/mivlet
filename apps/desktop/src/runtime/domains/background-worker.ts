import { invokeNative } from "../bridge";

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
  return (
    (await invokeNative<BackgroundWorkerStatus>(
      "background_worker_status",
    )) ?? {
      supported: false,
      enabled: false,
      running: false,
      protocol: 1,
      version: "",
      processId: null,
      activeWork: 0,
    }
  );
}

export async function controlBackgroundWorker(
  action: "start" | "stop" | "restart",
): Promise<BackgroundWorkerStatus> {
  const status = await invokeNative<BackgroundWorkerStatus>(
    "background_worker_control",
    { action },
  );
  if (!status)
    throw new Error("Background execution requires the installed Windows app.");
  return status;
}
