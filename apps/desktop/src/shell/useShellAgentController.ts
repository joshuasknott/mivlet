import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalResolutionRequest, HostedBrowserSnapshot } from "@fable/protocol";
import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import { createApprovalGate } from "@fable/connectors/native-api/tool-executor";
import { createBrowserSpeechProvider } from "@fable/connectors/voice";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import { cancelHostedScheduleWithApprovals } from "../lib/hosted-schedule-cancellation";
import { controlHostedScheduleWithApprovals } from "../lib/hosted-schedule-control";
import { createHostedScheduleWithApprovals, hostedScheduleDraftFromForm, type HostedScheduleFormInput } from "../lib/hosted-schedule-creation";
import {
  cancelHostedAgentRoutineWithApprovals,
  controlHostedAgentRoutineWithApprovals,
  createHostedAgentRoutineWithApprovals,
  hostedAgentRoutineDraftFromForm,
  type HostedAgentRoutineFormInput
} from "../lib/hosted-agent-routine";
import type { CitedBriefMissionPlanSummary } from "../lib/cited-brief-contract";
import { useNativeAgent } from "../hooks/useNativeAgent";
import { useHostedComputer } from "../hooks/useHostedComputer";
import { createDesktopDurableRunWriter, useDurableConversation } from "../hooks/useDurableConversation";
import { useScheduledAgent } from "../hooks/useScheduledAgent";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { useVoice } from "../hooks/useVoice";
import { cancelRuntimeCitedApproval, cancelRuntimeMissionApproval, cancelRuntimeMissionHumanInput, listRuntimePendingCitedApprovals, listRuntimePendingMissionApprovals, listRuntimePendingMissionHumanInputs, navigateRuntimeHostedBrowser, prepareRuntimeHostedBrowser, snapshotRuntimeHostedBrowser, verifiedLatestRuntimePendingMissionWait } from "../runtime";

export function useShellAgentController({ onDictation, onVoiceCancel, threadId }: { onDictation: (transcript: string) => void; onVoiceCancel: () => void; threadId?: string }) {
  const approvalGate = useMemo(() => createApprovalGate(), []);
  const runtime = useShellRuntime({ approvalGate });
  const cancelRequestedRef = useRef(false);
  const citedMissionRunningRef = useRef(false);
  const [citedMissionRunning, setCitedMissionRunning] = useState(false);
  const [hostedBrowserSnapshot, setHostedBrowserSnapshot] = useState<HostedBrowserSnapshot | null>(null);
  const [hostedBrowserPhase, setHostedBrowserPhase] = useState<"idle" | "preparing" | "awaiting-approval" | "opening" | "refreshing">("idle");
  const [hostedBrowserError, setHostedBrowserError] = useState<string | null>(null);
  const citedMissionCancelRef = useRef<(() => Promise<void>) | null>(null);
  const citedRecoveryScopeRef = useRef<string | null>(null);
  const activeWorkspaceId = runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId;
  const activeAgentId = runtime.activeAgentId ?? runtime.agents[0]?.id;
  const hostedWorkspaceId = runtime.accountWorkspaceStatus.activeWorkspace?.source === "hosted"
    ? runtime.accountWorkspaceStatus.activeWorkspace.fableWorkspaceId ?? null
    : null;
  const activeHostedDeviceId = runtime.accountWorkspaceStatus.devices.find((device) => device.status === "active")?.deviceId ?? null;
  const hostedComputer = useHostedComputer({
    workspaceId: hostedWorkspaceId,
    agentId: activeAgentId ?? "agent-unavailable",
    deviceId: activeHostedDeviceId
  });
  useEffect(() => { approvalGate.replaceStandingGrants([...runtime.sessionApprovalGrants, ...runtime.approvalRules]); }, [approvalGate, runtime.sessionApprovalGrants, runtime.approvalRules]);
  const queueToolApproval = (event: Parameters<typeof runtime.recordBackendToolCall>[0]) => { if (approvalGate.register(event.approval)) runtime.recordBackendToolCall(event); };
  const cancelHostedSchedule = async (scheduleId: string) => {
    if (
      !hostedWorkspaceId
      || !activeHostedDeviceId
      || !activeAgentId
      || hostedComputer.node?.status !== "ready"
      || !hostedComputer.node.keepAlive
    ) {
      throw new Error("This always-on schedule cannot be cancelled from the current cloud computer.");
    }
    const snapshot = await cancelHostedScheduleWithApprovals({
      workspaceId: hostedWorkspaceId,
      agentId: activeAgentId,
      deviceId: activeHostedDeviceId
    }, scheduleId, { gate: approvalGate, queueApproval: queueToolApproval });
    await hostedComputer.refreshSchedules();
    return snapshot;
  };
  const createHostedSchedule = async (input: HostedScheduleFormInput) => {
    if (
      !hostedWorkspaceId
      || !activeHostedDeviceId
      || !activeAgentId
      || hostedComputer.node?.status !== "ready"
      || !hostedComputer.node.keepAlive
    ) {
      throw new Error("This always-on schedule cannot be created on the current cloud computer.");
    }
    const draft = hostedScheduleDraftFromForm({
      workspaceId: hostedWorkspaceId,
      agentId: activeAgentId,
      deviceId: activeHostedDeviceId
    }, input);
    const firstRunMs = new Date(draft.firstRunAt).getTime();
    if (firstRunMs < Date.now() + 10_000) {
      throw new Error("Choose a first run time at least a few seconds in the future.");
    }
    if (firstRunMs > Date.now() + 30 * 24 * 60 * 60_000) {
      throw new Error("Choose a first run time within the next 30 days.");
    }
    const snapshot = await createHostedScheduleWithApprovals(draft, {
      gate: approvalGate,
      queueApproval: queueToolApproval
    });
    await hostedComputer.refreshSchedules();
    return snapshot;
  };
  const controlHostedSchedule = async (scheduleId: string, action: "pause" | "resume") => {
    if (!hostedWorkspaceId || !activeHostedDeviceId || !activeAgentId
      || hostedComputer.node?.status !== "ready" || !hostedComputer.node.keepAlive) {
      throw new Error("This always-on schedule cannot be changed from the current cloud computer.");
    }
    const snapshot = await controlHostedScheduleWithApprovals({
      workspaceId: hostedWorkspaceId,
      agentId: activeAgentId,
      deviceId: activeHostedDeviceId
    }, scheduleId, action, { gate: approvalGate, queueApproval: queueToolApproval });
    await hostedComputer.refreshSchedules();
    return snapshot;
  };
  const hostedRoutineScope = () => {
    if (!hostedWorkspaceId || !activeHostedDeviceId || !activeAgentId
      || hostedComputer.node?.status !== "ready" || !hostedComputer.node.keepAlive) {
      throw new Error("This cloud routine is unavailable from the current cloud computer.");
    }
    return { workspaceId: hostedWorkspaceId, agentId: activeAgentId, deviceId: activeHostedDeviceId };
  };
  const createHostedAgentRoutine = async (input: HostedAgentRoutineFormInput) => {
    const draft = hostedAgentRoutineDraftFromForm(hostedRoutineScope(), input);
    const firstRunMs = new Date(draft.firstRunAt).getTime();
    if (firstRunMs < Date.now() + 10_000) throw new Error("Choose a first run time at least a few seconds in the future.");
    if (firstRunMs > Date.now() + 30 * 24 * 60 * 60_000) throw new Error("Choose a first run time within the next 30 days.");
    const snapshot = await createHostedAgentRoutineWithApprovals(draft, {
      gate: approvalGate,
      queueApproval: queueToolApproval
    });
    await hostedComputer.refreshSchedules();
    return snapshot;
  };
  const cancelHostedAgentRoutine = async (routineId: string) => {
    const snapshot = await cancelHostedAgentRoutineWithApprovals(hostedRoutineScope(), routineId, {
      gate: approvalGate,
      queueApproval: queueToolApproval
    });
    await hostedComputer.refreshSchedules();
    return snapshot;
  };
  const controlHostedAgentRoutine = async (routineId: string, action: "pause" | "resume") => {
    const snapshot = await controlHostedAgentRoutineWithApprovals(hostedRoutineScope(), routineId, action, {
      gate: approvalGate,
      queueApproval: queueToolApproval
    });
    await hostedComputer.refreshSchedules();
    return snapshot;
  };
  useEffect(() => {
    setHostedBrowserSnapshot(null);
    setHostedBrowserError(null);
  }, [hostedWorkspaceId, activeAgentId]);
  const openHostedBrowser = async (url: string) => {
    if (!hostedWorkspaceId || !activeHostedDeviceId || !activeAgentId
      || hostedComputer.node?.status !== "ready" || !hostedComputer.node.keepAlive) {
      throw new Error("Set up this teammate's cloud computer before opening its browser.");
    }
    setHostedBrowserPhase("preparing");
    setHostedBrowserError(null);
    try {
      const prepared = await prepareRuntimeHostedBrowser({
        workspaceId: hostedWorkspaceId,
        agentId: activeAgentId,
        deviceId: activeHostedDeviceId,
        url
      });
      if (!prepared) throw new Error("Cloud browser navigation requires the desktop runtime.");
      queueToolApproval({
        callId: prepared.approval.id,
        tool: "cloud-browser",
        arguments: JSON.stringify({ url: prepared.proposal.url, computer: activeAgentId }),
        approval: prepared.approval
      });
      setHostedBrowserPhase("awaiting-approval");
      if (await approvalGate.waitForDecision(prepared.approval) !== "granted") {
        throw new Error("Cloud browser navigation was denied.");
      }
      setHostedBrowserPhase("opening");
      const resolution: ApprovalResolutionRequest = {
        request: prepared.approval,
        decision: "once",
        decidedAt: new Date().toISOString(),
        confirmationText: prepared.approval.confirmationPhrase
      };
      const snapshot = await navigateRuntimeHostedBrowser(prepared.proposal, resolution);
      if (!snapshot) throw new Error("Cloud browser navigation requires the desktop runtime.");
      setHostedBrowserSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The cloud browser is unavailable.";
      setHostedBrowserError(message);
      throw error;
    } finally {
      setHostedBrowserPhase("idle");
    }
  };
  const refreshHostedBrowser = async () => {
    if (!hostedWorkspaceId || !activeHostedDeviceId || !activeAgentId) return null;
    setHostedBrowserPhase("refreshing");
    setHostedBrowserError(null);
    try {
      const snapshot = await snapshotRuntimeHostedBrowser({
        workspaceId: hostedWorkspaceId,
        agentId: activeAgentId,
        deviceId: activeHostedDeviceId
      });
      if (!snapshot) throw new Error("Cloud browser inspection requires the desktop runtime.");
      setHostedBrowserSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The cloud browser is unavailable.";
      setHostedBrowserError(message);
      throw error;
    } finally {
      setHostedBrowserPhase("idle");
    }
  };
  const executor = useMemo(
    () =>
      createDesktopToolExecutor(approvalGate, {
        workspaceId: runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId,
        ...(hostedWorkspaceId && activeHostedDeviceId && activeAgentId ? {
          hostedComputer: {
            workspaceId: hostedWorkspaceId,
            agentId: activeAgentId,
            deviceId: activeHostedDeviceId,
            ready: hostedComputer.node?.status === "ready" && hostedComputer.node.keepAlive
          }
        } : {}),
        onHostedBrowserSnapshot: setHostedBrowserSnapshot,
        queueApproval: (approval, tool, argumentsJson) =>
          queueToolApproval({ callId: approval.id, tool, arguments: argumentsJson, approval })
      }),
    [
      approvalGate,
      runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId,
      hostedWorkspaceId,
      activeHostedDeviceId,
      activeAgentId,
      hostedComputer.node?.status,
      hostedComputer.node?.keepAlive
    ]
  );
  const cancelApprovals = () => { approvalGate.cancelPending(); runtime.clearBackendToolApprovals(); };
  const durableConversation = useDurableConversation({ workspaceId: runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId, threadId });
  const agent = useNativeAgent({ providers: runtime.backendProviders, activeProviderId: runtime.connectedAgentBackend?.id, models: runtime.selectableModels, threadId, createDurableRunWriter: createDesktopDurableRunWriter, execute: executor, shouldCancel: () => cancelRequestedRef.current, onCancel: () => { cancelRequestedRef.current = true; cancelApprovals(); }, onToolCall: queueToolApproval });
  useEffect(() => {
    if (!activeWorkspaceId || !agent.backend
      || agent.backend.backend.backendType !== "native-api" || agent.state.running) return;
    const scopeKey = `${activeWorkspaceId}:${agent.backend.providerId}`;
    if (citedRecoveryScopeRef.current === scopeKey || citedMissionRunningRef.current) return;
    citedRecoveryScopeRef.current = scopeKey;
    citedMissionRunningRef.current = true;
    setCitedMissionRunning(true);
    void (async () => {
      const cited = await Promise.allSettled([
        import("../lib/cited-brief-mission").then(({ resumeInterruptedCitedBriefMissions }) => resumeInterruptedCitedBriefMissions({
          resolveBackend: agent.resolveBackend,
          onCancellationReady: (cancel) => { citedMissionCancelRef.current = cancel; }
        }))
      ]);
      const general = await Promise.allSettled([
        import("../lib/runtime-mission-graph").then(({ resumeInterruptedRuntimeProviderMissions }) => resumeInterruptedRuntimeProviderMissions({
          resolveBackend: (route) =>
            agent.resolveBackend(route.providerFamily),
          executeMissionTool: async (toolInput) => {
            const approval = {
              ...buildToolApproval(
                toolInput.providerId,
                toolInput.tool,
                toolInput.argumentsJson
              ),
              id: toolInput.binding.callKey,
              requestedAt: new Date().toISOString()
            };
            queueToolApproval({
              callId: approval.id,
              tool: toolInput.tool,
              arguments: toolInput.argumentsJson,
              approval
            });
            const missionExecutor = createDesktopToolExecutor(approvalGate, {
              workspaceId: toolInput.workspaceId,
              ...(toolInput.projectId ? { projectId: toolInput.projectId } : {}),
              missionWorkerToolExecution: toolInput.binding,
              queueApproval: (request, tool, argumentsJson) =>
                queueToolApproval({
                  callId: request.id,
                  tool,
                  arguments: argumentsJson,
                  approval: request
                })
            });
            const output = await missionExecutor(approval, toolInput.argumentsJson);
            try {
              return JSON.parse(output) as unknown;
            } catch {
              throw new Error("The connected-source Mission evidence is invalid.");
            }
          },
          onCancellationReady: (cancel) => { citedMissionCancelRef.current = cancel; }
        }))
      ]);
      const failure = [...cited, ...general].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().catch(() => {
      citedRecoveryScopeRef.current = null;
    }).finally(async () => {
      citedMissionRunningRef.current = false;
      setCitedMissionRunning(false);
      citedMissionCancelRef.current = null;
      await durableConversation.refresh();
    });
  }, [
    activeWorkspaceId,
    agent.backend,
    agent.resolveBackend,
    agent.state.running,
    durableConversation.refresh
  ]);
  const voiceProvider = useMemo(() => createBrowserSpeechProvider(), []);
  const voice = useVoice(voiceProvider, onDictation, { disabled: false, onCancel: onVoiceCancel });
  useEffect(() => { if (!runtime.isChatView) voice.reset(); }, [runtime.isChatView, voice.reset]);
  const connectedConnectorIds = useMemo(() => runtime.connectorManifests.filter((connector) => connector.status === "connected").map((connector) => connector.id), [runtime.connectorManifests]);
  const scheduledAgent = useScheduledAgent(runtime.pendingWorkflowRuns, { providers: runtime.backendProviders, connectedConnectorIds, execute: executor, onToolApproval: queueToolApproval, onCancelApprovals: cancelApprovals, onComplete: (runId, result, workflowRun) => runtime.completeWorkflowRun(runId, result.ok, result.ok ? result.transcript : result.error, workflowRun) });
  const runCitedBrief = async (query: string, model: string, projectId?: string, onPlanReady?: (plan: CitedBriefMissionPlanSummary) => void) => {
    if (citedMissionRunningRef.current || agent.state.running) {
      throw new Error("Wait for the current work to finish before starting connected-source research.");
    }
    const workspace = runtime.accountWorkspaceStatus.activeWorkspace;
    if (!agent.backend || agent.backend.backend.backendType !== "native-api"
      || !workspace?.localWorkspaceId || !threadId) {
      throw new Error("Connected-source research requires the desktop runtime and a connected native model provider.");
    }
    citedMissionRunningRef.current = true;
    setCitedMissionRunning(true);
    try {
      const { executeCitedBriefMission } = await import("../lib/cited-brief-mission");
      return await executeCitedBriefMission({
        query,
        workspaceId: workspace.localWorkspaceId,
        missionScopeWorkspaceId: workspace.fableWorkspaceId ?? workspace.localWorkspaceId,
        sourceThreadId: threadId,
        projectId,
        backend: agent.backend,
        model,
        approvalGate,
        onPlanReady,
        onCancellationReady: (cancel) => { citedMissionCancelRef.current = cancel; },
        queueApproval: (approval, tool, argumentsJson) =>
          queueToolApproval({ callId: approval.id, tool, arguments: argumentsJson, approval })
      });
    } finally {
      citedMissionRunningRef.current = false;
      setCitedMissionRunning(false);
      citedMissionCancelRef.current = null;
    }
  };
  const stopCurrentWork = async () => {
    if (citedMissionRunningRef.current && citedMissionCancelRef.current) {
      cancelApprovals();
      await citedMissionCancelRef.current();
      return true;
    }
    if (agent.state.running) {
      await agent.cancel();
      return true;
    }
    if (threadId) {
      const [approvalResult, inputResult, effectApprovalResult] = await Promise.allSettled([
        listRuntimePendingCitedApprovals(threadId),
        listRuntimePendingMissionHumanInputs(threadId),
        listRuntimePendingMissionApprovals(threadId)
      ]);
      const latestWait = verifiedLatestRuntimePendingMissionWait(
        approvalResult,
        inputResult,
        effectApprovalResult
      );
      if (latestWait?.kind === "human-input") {
        await cancelRuntimeMissionHumanInput(latestWait.request);
        await durableConversation.refresh();
        return true;
      }
      if (latestWait?.kind === "approval") {
        await cancelRuntimeCitedApproval(latestWait.request);
        await durableConversation.refresh();
        return true;
      }
      if (latestWait?.kind === "effect-approval") {
        await cancelRuntimeMissionApproval(latestWait.request);
        await durableConversation.refresh();
        return true;
      }
    }
    return false;
  };
  return {
    runtime,
    agent,
    durableConversation,
    voice,
    hostedComputer: {
      ...hostedComputer,
      createSchedule: createHostedSchedule,
      cancelSchedule: cancelHostedSchedule,
      pauseSchedule: (scheduleId: string) => controlHostedSchedule(scheduleId, "pause"),
      resumeSchedule: (scheduleId: string) => controlHostedSchedule(scheduleId, "resume"),
      createAgentRoutine: createHostedAgentRoutine,
      cancelAgentRoutine: cancelHostedAgentRoutine,
      pauseAgentRoutine: (routineId: string) => controlHostedAgentRoutine(routineId, "pause"),
      resumeAgentRoutine: (routineId: string) => controlHostedAgentRoutine(routineId, "resume")
    },
    hostedBrowser: {
      snapshot: hostedBrowserSnapshot,
      opening: hostedBrowserPhase !== "idle",
      phase: hostedBrowserPhase,
      error: hostedBrowserError,
      open: openHostedBrowser,
      refresh: refreshHostedBrowser
    },
    scheduledActive: scheduledAgent.active,
    citedMissionRunning,
    runCitedBrief,
    stopCurrentWork,
    resetCancellation: () => { cancelRequestedRef.current = false; }
  };
}
