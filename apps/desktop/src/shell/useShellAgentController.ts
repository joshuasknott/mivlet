import { useEffect, useMemo, useRef } from "react";
import { createApprovalGate, createBrowserSpeechProvider } from "@fable/connectors";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import { useNativeAgent } from "../hooks/useNativeAgent";
import { createDesktopDurableRunWriter, useDurableConversation } from "../hooks/useDurableConversation";
import { useScheduledAgent } from "../hooks/useScheduledAgent";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { useVoice } from "../hooks/useVoice";

export function useShellAgentController({ onDictation, onVoiceCancel }: { onDictation: (transcript: string) => void; onVoiceCancel: () => void }) {
  const approvalGate = useMemo(() => createApprovalGate(), []);
  const runtime = useShellRuntime({ approvalGate });
  const cancelRequestedRef = useRef(false);
  useEffect(() => { approvalGate.replaceStandingGrants([...runtime.sessionApprovalGrants, ...runtime.approvalRules]); }, [approvalGate, runtime.sessionApprovalGrants, runtime.approvalRules]);
  const executor = useMemo(() => createDesktopToolExecutor(approvalGate), [approvalGate]);
  const queueToolApproval = (event: Parameters<typeof runtime.recordBackendToolCall>[0]) => { if (approvalGate.register(event.approval)) runtime.recordBackendToolCall(event); };
  const cancelApprovals = () => { approvalGate.cancelPending(); runtime.clearBackendToolApprovals(); };
  const durableConversation = useDurableConversation({ workspaceId: runtime.accountWorkspaceStatus.activeWorkspace?.localWorkspaceId, threadId: runtime.activeThread?.id });
  const agent = useNativeAgent({ providers: runtime.backendProviders, activeProviderId: runtime.connectedAgentBackend?.id, models: runtime.selectableModels, threadId: runtime.activeThread?.id, createDurableRunWriter: createDesktopDurableRunWriter, execute: executor, shouldCancel: () => cancelRequestedRef.current, onCancel: () => { cancelRequestedRef.current = true; cancelApprovals(); }, onToolCall: queueToolApproval });
  const voiceProvider = useMemo(() => createBrowserSpeechProvider(), []);
  const voice = useVoice(voiceProvider, onDictation, { disabled: false, onCancel: onVoiceCancel });
  useEffect(() => { if (!runtime.isChatView) voice.reset(); }, [runtime.isChatView, voice.reset]);
  const connectedConnectorIds = useMemo(() => runtime.connectorManifests.filter((connector) => connector.status === "connected").map((connector) => connector.id), [runtime.connectorManifests]);
  const scheduledAgent = useScheduledAgent(runtime.pendingWorkflowRuns, { providers: runtime.backendProviders, connectedConnectorIds, execute: executor, onToolApproval: queueToolApproval, onCancelApprovals: cancelApprovals, onComplete: (runId, result, workflowRun) => runtime.completeWorkflowRun(runId, result.ok, result.ok ? result.transcript : result.error, workflowRun) });
  return { runtime, agent, durableConversation, voice, scheduledActive: scheduledAgent.active, resetCancellation: () => { cancelRequestedRef.current = false; } };
}
