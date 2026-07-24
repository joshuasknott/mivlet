import { useEffect, useMemo, useRef, useState } from "react";
import { createApprovalGate, createBrowserSpeechProvider } from "@fable/connectors";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import { executeCitedBriefMission, resumeInterruptedCitedBriefMissions, type CitedBriefMissionPlanSummary } from "../lib/cited-brief-mission";
import { useNativeAgent } from "../hooks/useNativeAgent";
import { createDesktopDurableRunWriter, useDurableConversation } from "../hooks/useDurableConversation";
import { useScheduledAgent } from "../hooks/useScheduledAgent";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { useVoice } from "../hooks/useVoice";
import { cancelRuntimeCitedApproval, cancelRuntimeMissionApproval, cancelRuntimeMissionHumanInput, listRuntimePendingCitedApprovals, listRuntimePendingMissionApprovals, listRuntimePendingMissionHumanInputs, verifiedLatestRuntimePendingMissionWait } from "../runtime";

export function useShellAgentController({ onDictation, onVoiceCancel, threadId }: { onDictation: (transcript: string) => void; onVoiceCancel: () => void; threadId?: string }) {
  const approvalGate = useMemo(() => createApprovalGate(), []);
  const runtime = useShellRuntime({ approvalGate });
  const cancelRequestedRef = useRef(false);
  const citedMissionRunningRef = useRef(false);
  const [citedMissionRunning, setCitedMissionRunning] = useState(false);
  const citedMissionCancelRef = useRef<(() => Promise<void>) | null>(null);
  const citedRecoveryScopeRef = useRef<string | null>(null);
  const activeWorkspaceId = runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId;
  useEffect(() => { approvalGate.replaceStandingGrants([...runtime.sessionApprovalGrants, ...runtime.approvalRules]); }, [approvalGate, runtime.sessionApprovalGrants, runtime.approvalRules]);
  const queueToolApproval = (event: Parameters<typeof runtime.recordBackendToolCall>[0]) => { if (approvalGate.register(event.approval)) runtime.recordBackendToolCall(event); };
  const executor = useMemo(
    () =>
      createDesktopToolExecutor(approvalGate, {
        workspaceId: runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId,
        queueApproval: (approval, tool, argumentsJson) =>
          queueToolApproval({ callId: approval.id, tool, arguments: argumentsJson, approval })
      }),
    [approvalGate, runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId]
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
    void resumeInterruptedCitedBriefMissions({
      backend: agent.backend,
      onCancellationReady: (cancel) => { citedMissionCancelRef.current = cancel; }
    }).catch(() => {
      citedRecoveryScopeRef.current = null;
    }).finally(async () => {
      citedMissionRunningRef.current = false;
      setCitedMissionRunning(false);
      citedMissionCancelRef.current = null;
      await durableConversation.refresh();
    });
  }, [activeWorkspaceId, agent.backend, agent.state.running, durableConversation.refresh]);
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
  return { runtime, agent, durableConversation, voice, scheduledActive: scheduledAgent.active, citedMissionRunning, runCitedBrief, stopCurrentWork, resetCancellation: () => { cancelRequestedRef.current = false; } };
}
