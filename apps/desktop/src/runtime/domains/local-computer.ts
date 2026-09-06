import type {
  LocalBrowserKeyRequest,
  LocalBrowserHistoryRequest,
  LocalBrowserNavigateRequest,
  LocalBrowserPointerRequest,
  LocalBrowserSnapshot,
  LocalComputerControlRequest,
  LocalComputerFilePreview,
  LocalComputerFileRequest,
  LocalComputerFilesSnapshot,
  LocalComputerLaunchRequest,
  LocalComputerSnapshot,
  LocalComputerTarget,
  LocalComputerEpochRequest,
  LocalComputerViewerReceipt,
} from "@fable/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";

export interface LocalComputerRuntimePort {
  load(target: LocalComputerTarget): Promise<LocalComputerSnapshot | null>;
  provision(target: LocalComputerTarget): Promise<LocalComputerSnapshot | null>;
  files(
    target: LocalComputerTarget,
  ): Promise<LocalComputerFilesSnapshot | null>;
  previewFile(
    request: LocalComputerFileRequest,
  ): Promise<LocalComputerFilePreview | null>;
  snapshot(target: LocalComputerTarget): Promise<LocalBrowserSnapshot | null>;
  navigate(
    request: LocalBrowserNavigateRequest,
  ): Promise<LocalBrowserSnapshot | null>;
  setController(
    request: LocalComputerControlRequest,
  ): Promise<LocalBrowserSnapshot | null>;
  pointer(
    request: LocalBrowserPointerRequest,
  ): Promise<LocalBrowserSnapshot | null>;
  key(request: LocalBrowserKeyRequest): Promise<LocalBrowserSnapshot | null>;
  history(
    request: LocalBrowserHistoryRequest,
  ): Promise<LocalBrowserSnapshot | null>;
  launchApplication(
    request: LocalComputerLaunchRequest,
  ): Promise<LocalBrowserSnapshot | null>;
}

function createPort(adapter: RuntimeAdapter): LocalComputerRuntimePort {
  const native = adapter.kind === "native";
  const invoke = <T>(command: string, args: Record<string, unknown>) =>
    adapter.invoke<T>(command, args).catch((error: unknown) => {
      throw toRuntimeError(error);
    });
  return {
    load: (target) =>
      native
        ? invoke("local_computer_status", { ...target })
        : Promise.resolve(null),
    provision: (target) =>
      native
        ? invoke("local_computer_provision", { ...target })
        : Promise.resolve(null),
    files: (target) =>
      native
        ? invoke("local_computer_files", { target })
        : Promise.resolve(null),
    previewFile: (request) =>
      native
        ? invoke("local_computer_file_preview", { request })
        : Promise.resolve(null),
    snapshot: (target) =>
      native
        ? invoke("local_browser_snapshot", { target })
        : Promise.resolve(null),
    navigate: (request) =>
      native
        ? invoke("local_browser_navigate", { request })
        : Promise.resolve(null),
    setController: (request) =>
      native
        ? invoke("local_computer_set_controller", { request })
        : Promise.resolve(null),
    pointer: (request) =>
      native
        ? invoke("local_browser_pointer", { request })
        : Promise.resolve(null),
    key: (request) =>
      native ? invoke("local_browser_key", { request }) : Promise.resolve(null),
    history: (request) =>
      native
        ? invoke("local_browser_history", { request })
        : Promise.resolve(null),
    launchApplication: (request) =>
      native
        ? invoke("local_computer_launch_app", { request })
        : Promise.resolve(null),
  };
}

const ports = new WeakMap<RuntimeAdapter, LocalComputerRuntimePort>();

function port(): LocalComputerRuntimePort {
  const adapter = getRuntimeAdapter();
  const existing = ports.get(adapter);
  if (existing) return existing;
  const created = createPort(adapter);
  ports.set(adapter, created);
  return created;
}

export const loadRuntimeLocalComputer = (target: LocalComputerTarget) =>
  port().load(target);
export const provisionRuntimeLocalComputer = (target: LocalComputerTarget) =>
  port().provision(target);
export const listRuntimeLocalComputerFiles = (target: LocalComputerTarget) =>
  port().files(target);
export const previewRuntimeLocalComputerFile = (
  request: LocalComputerFileRequest,
) => port().previewFile(request);
export const snapshotRuntimeLocalBrowser = (target: LocalComputerTarget) =>
  port().snapshot(target);
export const navigateRuntimeLocalBrowser = (
  request: LocalBrowserNavigateRequest,
) => port().navigate(request);
export const setRuntimeLocalComputerController = (
  request: LocalComputerControlRequest,
) => port().setController(request);
export const pointRuntimeLocalBrowser = (request: LocalBrowserPointerRequest) =>
  port().pointer(request);
export const keyRuntimeLocalBrowser = (request: LocalBrowserKeyRequest) =>
  port().key(request);
export const historyRuntimeLocalBrowser = (
  request: LocalBrowserHistoryRequest,
) => port().history(request);
export const launchRuntimeLocalComputerApplication = (
  request: LocalComputerLaunchRequest,
) => port().launchApplication(request);

async function nativeComputerCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native") return null;
  return adapter.invoke<T>(command, args).catch((error: unknown) => {
    throw toRuntimeError(error);
  });
}
export const openRuntimeLocalComputerViewer = (
  request: LocalComputerEpochRequest,
) =>
  nativeComputerCommand<LocalComputerViewerReceipt>(
    "local_computer_open_viewer",
    { request },
  );
export const closeRuntimeLocalComputerViewer = (sessionId: string) =>
  nativeComputerCommand<void>("local_computer_close_viewer", { sessionId });
export const cancelRuntimeLocalComputer = (
  request: LocalComputerEpochRequest,
) =>
  nativeComputerCommand<LocalComputerSnapshot>("local_computer_cancel", {
    request,
  });
