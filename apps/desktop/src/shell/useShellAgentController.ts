import { useEffect, useMemo, useRef } from "react";
import { createApprovalGate, createBrowserSpeechProvider } from "@fable/connectors";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import { executeCitedBriefMission } from "../lib/cited-brief-mission";
import { useNativeAgent } from "../hooks/useNativeAgent";
import { createDesktopDurableRunWriter, useDurableConversation } from "../hooks/useDurableConversation";
import { useScheduledAgent } from "../hooks/useScheduledAgent";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { useVoice } from "../hooks/useVoice";
import { recoverRuntimeInterruptedCitedMissions } from "../runtime";

export function useShellAgentController({ onDictation, onVoiceCancel, threadId }: { onDictation: (transcript: string) => void; onVoiceCancel: () => void; threadId?: string }) {
  const approvalGate = useMemo(() => createApprovalGate(), []);
  const runtime = useShellRuntime({ approvalGate });
  const cancelRequestedRef = useRef(false);
  const citedMissionRunningRef = useRef(false);
  const citedMissionCancelRef = useRef<(() => Promise<void>) | null>(null);
  const activeWorkspaceId = runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    void recoverRuntimeInterruptedCitedMissions().catch(() => undefined);
  }, [activeWorkspaceId]);
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
  const voiceProvider = useMemo(() => createBrowserSpeechProvider(), []);
  const voice = useVoice(voiceProvider, onDictation, { disabled: false, onCancel: onVoiceCancel });
  useEffect(() => { if (!runtime.isChatView) voice.reset(); }, [runtime.isChatView, voice.reset]);
  const connectedConnectorIds = useMemo(() => runtime.connectorManifests.filter((connector) => connector.status === "connected").map((connector) => connector.id), [runtime.connectorManifests]);
  const scheduledAgent = useScheduledAgent(runtime.pendingWorkflowRuns, { providers: runtime.backendProviders, connectedConnectorIds, execute: executor, onToolApproval: queueToolApproval, onCancelApprovals: cancelApprovals, onComplete: (runId, result, workflowRun) => runtime.completeWorkflowRun(runId, result.ok, result.ok ? result.transcript : result.error, workflowRun) });
  const runCitedBrief = async (query: string, model: string, projectId?: string) => {
    if (citedMissionRunningRef.current || agent.state.running) {
      throw new Error("Wait for the current work to finish before starting connected-source research.");
    }
    const workspace = runtime.accountWorkspaceStatus.activeWorkspace;
    if (!agent.backend || !workspace?.localWorkspaceId) {
      throw new Error("Connected-source research requires the desktop runtime and a connected OpenAI API provider.");
    }
    citedMissionRunningRef.current = true;
    try {
      return await executeCitedBriefMission({
        query,
        workspaceId: workspace.localWorkspaceId,
        missionScopeWorkspaceId: workspace.fableWorkspaceId ?? workspace.localWorkspaceId,
        projectId,
        backend: agent.backend,
        model,
        approvalGate,
        onCancellationReady: (cancel) => { citedMissionCancelRef.current = cancel; },
        queueApproval: (approval, tool, argumentsJson) =>
          queueToolApproval({ callId: approval.id, tool, arguments: argumentsJson, approval })
      });
    } finally {
      citedMissionRunningRef.current = false;
      citedMissionCancelRef.current = null;
    }
  };
  const stopCurrentWork = async () => {
    if (citedMissionRunningRef.current && citedMissionCancelRef.current) {
      cancelApprovals();
      await citedMissionCancelRef.current();
      return true;
    }
    if (!agent.state.running) return false;
    await agent.cancel();
    return true;
  };
  return { runtime, agent, durableConversation, voice, scheduledActive: scheduledAgent.active, runCitedBrief, stopCurrentWork, resetCancellation: () => { cancelRequestedRef.current = false; } };
}
