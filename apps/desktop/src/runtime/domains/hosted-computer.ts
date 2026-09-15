import type {
  ApprovalResolutionRequest,
  HostedBrowserActionDraft,
  HostedBrowserActionProposal,
  HostedBrowserNavigateDraft,
  HostedBrowserNavigateProposal,
  HostedBrowserSnapshot,
  HostedBrowserTarget,
  HostedComputerProvisionReceipt,
  HostedExecutionNodeSnapshot,
  HostedProcessDraft,
  HostedProcessLaunchProposal,
  HostedProcessSnapshot,
  HostedProcessTarget,
  PreparedHostedBrowserAction,
  PreparedHostedBrowserNavigation,
  PreparedHostedProcessLaunch,
} from "@fable/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";

interface HostedComputerRuntimePort {
  load(
    workspaceId: string,
    agentId: string,
  ): Promise<HostedExecutionNodeSnapshot | null>;
  provision(
    workspaceId: string,
    agentId: string,
    deviceId: string,
  ): Promise<HostedComputerProvisionReceipt | null>;
  prepareProcess(
    draft: HostedProcessDraft,
  ): Promise<PreparedHostedProcessLaunch | null>;
  launchProcess(
    proposal: HostedProcessLaunchProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedProcessSnapshot | null>;
  inspectProcess(
    target: HostedProcessTarget,
  ): Promise<HostedProcessSnapshot | null>;
  killProcess(
    target: HostedProcessTarget,
  ): Promise<HostedProcessSnapshot | null>;
  prepareBrowser(
    draft: HostedBrowserNavigateDraft,
  ): Promise<PreparedHostedBrowserNavigation | null>;
  navigateBrowser(
    proposal: HostedBrowserNavigateProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution?: ApprovalResolutionRequest,
  ): Promise<HostedBrowserSnapshot | null>;
  prepareBrowserAction(
    draft: HostedBrowserActionDraft,
  ): Promise<PreparedHostedBrowserAction | null>;
  actBrowser(
    proposal: HostedBrowserActionProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedBrowserSnapshot | null>;
  snapshotBrowser(
    target: HostedBrowserTarget,
  ): Promise<HostedBrowserSnapshot | null>;
  openLiveView(target: HostedBrowserTarget): Promise<boolean>;
}

function createPort(adapter: RuntimeAdapter): HostedComputerRuntimePort {
  const native = adapter.kind === "native";
  const invoke = <T>(command: string, args: Record<string, unknown>) =>
    adapter.invoke<T>(command, args).catch((error: unknown) => {
      throw toRuntimeError(error);
    });
  return {
    load: (workspaceId, agentId) =>
      native
        ? invoke("hosted_computer_status", { workspaceId, agentId })
        : Promise.resolve(null),
    provision: (workspaceId, agentId, deviceId) =>
      native
        ? invoke("hosted_computer_provision", {
            workspaceId,
            agentId,
            deviceId,
          })
        : Promise.resolve(null),
    prepareProcess: (draft) =>
      native
        ? invoke("hosted_process_prepare", { draft })
        : Promise.resolve(null),
    launchProcess: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_process_launch", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    inspectProcess: (target) =>
      native
        ? invoke("hosted_process_status", { target })
        : Promise.resolve(null),
    killProcess: (target) =>
      native
        ? invoke("hosted_process_kill", { target })
        : Promise.resolve(null),
    prepareBrowser: (draft) =>
      native
        ? invoke("hosted_browser_prepare", { draft })
        : Promise.resolve(null),
    navigateBrowser: (proposal, resolution, sourceResolution) =>
      native
        ? invoke<HostedBrowserSnapshot>("hosted_browser_navigate", {
            request: {
              proposal,
              resolution,
              ...(sourceResolution ? { sourceResolution } : {}),
            },
          }).then(toPublicHostedBrowserSnapshot)
        : Promise.resolve(null),
    prepareBrowserAction: (draft) =>
      native
        ? invoke("hosted_browser_action_prepare", { draft })
        : Promise.resolve(null),
    actBrowser: (proposal, resolution, sourceResolution) =>
      native
        ? invoke<HostedBrowserSnapshot>("hosted_browser_action", {
            request: { proposal, resolution, sourceResolution },
          }).then(toPublicHostedBrowserSnapshot)
        : Promise.resolve(null),
    snapshotBrowser: (target) =>
      native
        ? invoke<HostedBrowserSnapshot>("hosted_browser_snapshot", { target }).then(
            toPublicHostedBrowserSnapshot,
          )
        : Promise.resolve(null),
    openLiveView: (target) =>
      native
        ? invoke("hosted_browser_open_live_view", { target }).then(() => true)
        : Promise.resolve(false),
  };
}

const ports = new WeakMap<RuntimeAdapter, HostedComputerRuntimePort>();

function port() {
  const adapter = getRuntimeAdapter();
  const existing = ports.get(adapter);
  if (existing) return existing;
  const created = createPort(adapter);
  ports.set(adapter, created);
  return created;
}

export const loadRuntimeHostedComputer = (
  workspaceId: string,
  agentId: string,
) => port().load(workspaceId, agentId);
export const provisionRuntimeHostedComputer = (
  workspaceId: string,
  agentId: string,
  deviceId: string,
) => port().provision(workspaceId, agentId, deviceId);
export const prepareRuntimeHostedProcess = (draft: HostedProcessDraft) =>
  port().prepareProcess(draft);
export const launchRuntimeHostedProcess = (
  proposal: HostedProcessLaunchProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().launchProcess(proposal, resolution, sourceResolution);
export const inspectRuntimeHostedProcess = (target: HostedProcessTarget) =>
  port().inspectProcess(target);
export const killRuntimeHostedProcess = (target: HostedProcessTarget) =>
  port().killProcess(target);
export const prepareRuntimeHostedBrowser = (
  draft: HostedBrowserNavigateDraft,
) => port().prepareBrowser(draft);
export const navigateRuntimeHostedBrowser = (
  proposal: HostedBrowserNavigateProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution?: ApprovalResolutionRequest,
) => port().navigateBrowser(proposal, resolution, sourceResolution);
export const snapshotRuntimeHostedBrowser = (target: HostedBrowserTarget) =>
  port().snapshotBrowser(target);
export const prepareRuntimeHostedBrowserAction = (
  draft: HostedBrowserActionDraft,
) => port().prepareBrowserAction(draft);
export const actRuntimeHostedBrowser = (
  proposal: HostedBrowserActionProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().actBrowser(proposal, resolution, sourceResolution);
export const openRuntimeHostedLiveView = (target: HostedBrowserTarget) =>
  port().openLiveView(target);

export function toPublicHostedBrowserSnapshot(
  snapshot: HostedBrowserSnapshot,
): HostedBrowserSnapshot {
  const { liveViewUrl, ...rest } = snapshot;
  return {
    ...rest,
    takeoverAvailable: rest.takeoverAvailable === true || Boolean(liveViewUrl),
  };
}
