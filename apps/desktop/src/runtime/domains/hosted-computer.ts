import type {
  ApprovalResolutionRequest,
  HostedAgentRoutineDraft,
  HostedAgentRoutineProposal,
  HostedAgentRoutineSnapshot,
  HostedAgentRoutineRunSnapshot,
  HostedAgentRoutineTarget,
  HostedAgentRoutineListTarget,
  HostedAgentRoutineCancelProposal,
  HostedAgentRoutineControlDraft,
  HostedAgentRoutineControlProposal,
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
  HostedProcessScheduleDraft,
  HostedProcessScheduleCancelProposal,
  HostedProcessScheduleControlDraft,
  HostedProcessScheduleControlProposal,
  HostedProcessScheduleListTarget,
  HostedProcessScheduleProposal,
  HostedProcessScheduleRunSnapshot,
  HostedProcessScheduleSnapshot,
  HostedProcessScheduleTarget,
  HostedProcessSnapshot,
  HostedProcessTarget,
  PreparedHostedBrowserNavigation,
  PreparedHostedAgentRoutine,
  PreparedHostedAgentRoutineCancel,
  PreparedHostedAgentRoutineControl,
  PreparedHostedBrowserAction,
  PreparedHostedProcessLaunch,
  PreparedHostedProcessSchedule,
  PreparedHostedProcessScheduleCancel,
  PreparedHostedProcessScheduleControl,
} from "@fable/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";

export interface HostedComputerRuntimePort {
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
  prepareSchedule(
    draft: HostedProcessScheduleDraft,
  ): Promise<PreparedHostedProcessSchedule | null>;
  createSchedule(
    proposal: HostedProcessScheduleProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedProcessScheduleSnapshot | null>;
  inspectSchedule(
    target: HostedProcessScheduleTarget,
  ): Promise<HostedProcessScheduleSnapshot | null>;
  listSchedules(
    target: HostedProcessScheduleListTarget,
  ): Promise<HostedProcessScheduleSnapshot[] | null>;
  listScheduleRuns(
    target: HostedProcessScheduleListTarget,
  ): Promise<HostedProcessScheduleRunSnapshot[] | null>;
  prepareScheduleCancel(
    target: HostedProcessScheduleTarget,
  ): Promise<PreparedHostedProcessScheduleCancel | null>;
  cancelSchedule(
    proposal: HostedProcessScheduleCancelProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedProcessScheduleSnapshot | null>;
  prepareScheduleControl(
    draft: HostedProcessScheduleControlDraft,
  ): Promise<PreparedHostedProcessScheduleControl | null>;
  controlSchedule(
    proposal: HostedProcessScheduleControlProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedProcessScheduleSnapshot | null>;
  prepareAgentRoutine(
    draft: HostedAgentRoutineDraft,
  ): Promise<PreparedHostedAgentRoutine | null>;
  createAgentRoutine(
    proposal: HostedAgentRoutineProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedAgentRoutineSnapshot | null>;
  listAgentRoutines(
    target: HostedAgentRoutineListTarget,
  ): Promise<HostedAgentRoutineSnapshot[] | null>;
  listAgentRoutineRuns(
    target: HostedAgentRoutineListTarget,
  ): Promise<HostedAgentRoutineRunSnapshot[] | null>;
  prepareAgentRoutineCancel(
    target: HostedAgentRoutineTarget,
  ): Promise<PreparedHostedAgentRoutineCancel | null>;
  cancelAgentRoutine(
    proposal: HostedAgentRoutineCancelProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedAgentRoutineSnapshot | null>;
  prepareAgentRoutineControl(
    draft: HostedAgentRoutineControlDraft,
  ): Promise<PreparedHostedAgentRoutineControl | null>;
  controlAgentRoutine(
    proposal: HostedAgentRoutineControlProposal,
    resolution: ApprovalResolutionRequest,
    sourceResolution: ApprovalResolutionRequest,
  ): Promise<HostedAgentRoutineSnapshot | null>;
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
    prepareSchedule: (draft) =>
      native
        ? invoke("hosted_process_schedule_prepare", { draft })
        : Promise.resolve(null),
    createSchedule: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_process_schedule_create", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    inspectSchedule: (target) =>
      native
        ? invoke("hosted_process_schedule_status", { target })
        : Promise.resolve(null),
    listSchedules: (target) =>
      native
        ? invoke("hosted_process_schedule_list", { target })
        : Promise.resolve(null),
    listScheduleRuns: (target) =>
      native
        ? invoke("hosted_process_schedule_run_list", { target })
        : Promise.resolve(null),
    prepareScheduleCancel: (target) =>
      native
        ? invoke("hosted_process_schedule_cancel_prepare", { target })
        : Promise.resolve(null),
    cancelSchedule: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_process_schedule_cancel", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    prepareScheduleControl: (draft) =>
      native
        ? invoke("hosted_process_schedule_control_prepare", { draft })
        : Promise.resolve(null),
    controlSchedule: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_process_schedule_control", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    prepareAgentRoutine: (draft) =>
      native
        ? invoke("hosted_agent_routine_prepare", { draft })
        : Promise.resolve(null),
    createAgentRoutine: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_agent_routine_create", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    listAgentRoutines: (target) =>
      native
        ? invoke("hosted_agent_routine_list", { target })
        : Promise.resolve(null),
    listAgentRoutineRuns: (target) =>
      native
        ? invoke("hosted_agent_routine_run_list", { target })
        : Promise.resolve(null),
    prepareAgentRoutineCancel: (target) =>
      native
        ? invoke("hosted_agent_routine_cancel_prepare", { target })
        : Promise.resolve(null),
    cancelAgentRoutine: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_agent_routine_cancel", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    prepareAgentRoutineControl: (draft) =>
      native
        ? invoke("hosted_agent_routine_control_prepare", { draft })
        : Promise.resolve(null),
    controlAgentRoutine: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_agent_routine_control", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    prepareBrowser: (draft) =>
      native
        ? invoke("hosted_browser_prepare", { draft })
        : Promise.resolve(null),
    navigateBrowser: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_browser_navigate", {
            request: {
              proposal,
              resolution,
              ...(sourceResolution ? { sourceResolution } : {}),
            },
          })
        : Promise.resolve(null),
    prepareBrowserAction: (draft) =>
      native
        ? invoke("hosted_browser_action_prepare", { draft })
        : Promise.resolve(null),
    actBrowser: (proposal, resolution, sourceResolution) =>
      native
        ? invoke("hosted_browser_action", {
            request: { proposal, resolution, sourceResolution },
          })
        : Promise.resolve(null),
    snapshotBrowser: (target) =>
      native
        ? invoke("hosted_browser_snapshot", { target })
        : Promise.resolve(null),
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
export const prepareRuntimeHostedProcessSchedule = (
  draft: HostedProcessScheduleDraft,
) => port().prepareSchedule(draft);
export const createRuntimeHostedProcessSchedule = (
  proposal: HostedProcessScheduleProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().createSchedule(proposal, resolution, sourceResolution);
export const inspectRuntimeHostedProcessSchedule = (
  target: HostedProcessScheduleTarget,
) => port().inspectSchedule(target);
export const listRuntimeHostedProcessSchedules = (
  target: HostedProcessScheduleListTarget,
) => port().listSchedules(target);
export const listRuntimeHostedProcessScheduleRuns = (
  target: HostedProcessScheduleListTarget,
) => port().listScheduleRuns(target);
export const prepareRuntimeHostedProcessScheduleCancel = (
  target: HostedProcessScheduleTarget,
) => port().prepareScheduleCancel(target);
export const cancelRuntimeHostedProcessSchedule = (
  proposal: HostedProcessScheduleCancelProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().cancelSchedule(proposal, resolution, sourceResolution);
export const prepareRuntimeHostedProcessScheduleControl = (
  draft: HostedProcessScheduleControlDraft,
) => port().prepareScheduleControl(draft);
export const controlRuntimeHostedProcessSchedule = (
  proposal: HostedProcessScheduleControlProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().controlSchedule(proposal, resolution, sourceResolution);
export const prepareRuntimeHostedAgentRoutine = (
  draft: HostedAgentRoutineDraft,
) => port().prepareAgentRoutine(draft);
export const createRuntimeHostedAgentRoutine = (
  proposal: HostedAgentRoutineProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().createAgentRoutine(proposal, resolution, sourceResolution);
export const listRuntimeHostedAgentRoutines = (
  target: HostedAgentRoutineListTarget,
) => port().listAgentRoutines(target);
export const listRuntimeHostedAgentRoutineRuns = (
  target: HostedAgentRoutineListTarget,
) => port().listAgentRoutineRuns(target);
export const prepareRuntimeHostedAgentRoutineCancel = (
  target: HostedAgentRoutineTarget,
) => port().prepareAgentRoutineCancel(target);
export const cancelRuntimeHostedAgentRoutine = (
  proposal: HostedAgentRoutineCancelProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().cancelAgentRoutine(proposal, resolution, sourceResolution);
export const prepareRuntimeHostedAgentRoutineControl = (
  draft: HostedAgentRoutineControlDraft,
) => port().prepareAgentRoutineControl(draft);
export const controlRuntimeHostedAgentRoutine = (
  proposal: HostedAgentRoutineControlProposal,
  resolution: ApprovalResolutionRequest,
  sourceResolution: ApprovalResolutionRequest,
) => port().controlAgentRoutine(proposal, resolution, sourceResolution);
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
