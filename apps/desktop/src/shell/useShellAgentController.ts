import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalResolutionRequest,
  HostedBrowserSnapshot,
} from "@fable/protocol";
import { createApprovalGate } from "@fable/connectors/native-api/tool-executor";
import { createBrowserSpeechProvider } from "@fable/connectors/voice";
import { useHostedComputer } from "../hooks/useHostedComputer";
import { useLocalComputer } from "../hooks/useLocalComputer";
import { useNativeAgent } from "../hooks/useNativeAgent";
import {
  createDesktopDurableRunWriter,
  loadDesktopConversation,
  useDurableConversation,
} from "../hooks/useDurableConversation";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { useVoice } from "../hooks/useVoice";
import { createDesktopToolExecutor, type DesktopToolExecutorOptions } from "../lib/desktop-tool-runtime";
import { listRuntimeMcpServerConfigurations } from "../runtime";
import { remoteConnectors, remoteConnectorServerId } from "../components/marketplace/remote-connectors";
import { chatConnectorIds } from "../lib/connector-chat";
import { isLocalComputerTool } from "../lib/computer-tools";
import {
  navigateRuntimeHostedBrowser,
  prepareRuntimeHostedBrowser,
  snapshotRuntimeHostedBrowser,
  cancelRuntimeLocalComputer,
} from "../runtime";

export function useShellAgentController({
  onDictation,
  onVoiceCancel,
  threadId,
  thumbnailEnabled = true,
}: {
  onDictation: (transcript: string) => void;
  onVoiceCancel: () => void;
  threadId?: string;
  thumbnailEnabled?: boolean;
}) {
  const gateRef = useRef<ReturnType<typeof createApprovalGate> | null>(null);
  if (!gateRef.current) gateRef.current = createApprovalGate();
  const approvalGate = gateRef.current;
  const scopeResetRef = useRef<() => void>(() => {});
  const cancelledScopeAttemptRef = useRef<string | null>(null);
  const executionActivityRef = useRef<(approvalId: string, tool: string) => void>(() => {});
  const runtime = useShellRuntime({ approvalGate, onScopeReset: () => scopeResetRef.current() });
  const cancelRequestedRef = useRef(false);
  const [hostedBrowserSnapshot, setHostedBrowserSnapshot] =
    useState<HostedBrowserSnapshot | null>(null);
  const [hostedBrowserPhase, setHostedBrowserPhase] = useState<
    "idle" | "preparing" | "awaiting-approval" | "opening" | "refreshing"
  >("idle");
  const [hostedBrowserError, setHostedBrowserError] = useState<string | null>(
    null,
  );

  const resolvedWorkspaceRef = useRef(false);
  if (!runtime.accountWorkspacePending) resolvedWorkspaceRef.current = true;
  const activeWorkspaceId =
    resolvedWorkspaceRef.current &&
    runtime.accountWorkspaceStatus.accountBound &&
    (runtime.accountWorkspaceStatus.state === "ready" ||
      runtime.accountWorkspaceStatus.state === "offline") &&
    runtime.accountWorkspaceStatus.activeWorkspace.source === "local"
      ? runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId
      : undefined;
  const activeAgentId = runtime.activeAgentId ?? runtime.agents[0]?.id;
  const connectorAccessRef = useRef({ workspaceId: activeWorkspaceId, agentId: activeAgentId, ids: [] as string[] });
  const turnConnectorsRef = useRef({ workspaceId: activeWorkspaceId, agentId: activeAgentId, ids: [] as string[] });
  const turn = turnConnectorsRef.current;
  connectorAccessRef.current = { workspaceId: activeWorkspaceId, agentId: activeAgentId,
    ids: chatConnectorIds(turn.workspaceId === activeWorkspaceId && turn.agentId === activeAgentId ? turn.ids : [], runtime.connectorManifests) };
  const hostedWorkspaceId =
    runtime.accountWorkspaceStatus.workspaces.find(
      (workspace) =>
        workspace.workspaceStatus === "active" &&
        workspace.membershipStatus === "active",
    )?.fableWorkspaceId ?? null;
  const activeHostedDeviceId =
    runtime.accountWorkspaceStatus.devices.find(
      (device) => device.status === "active",
    )?.deviceId ?? null;

  const localComputer = useLocalComputer({
    workspaceId: activeWorkspaceId,
    agentId: activeAgentId ?? "agent-unavailable",
    thumbnailEnabled,
  });
  const localComputerRef = useRef<DesktopToolExecutorOptions["localComputer"]>(undefined);
  localComputerRef.current = activeWorkspaceId && activeAgentId ? {
    workspaceId: activeWorkspaceId, agentId: activeAgentId,
    ready: localComputer.node?.lifecycle === "ready",
    generation: localComputer.node?.generation,
    controller: localComputer.node?.controller,
  } : undefined;
  const hostedComputer = useHostedComputer({
    workspaceId: hostedWorkspaceId,
    agentId: activeAgentId ?? "agent-unavailable",
    deviceId: activeHostedDeviceId,
  });

  useEffect(() => {
    approvalGate.replaceStandingGrants([
      ...runtime.sessionApprovalGrants,
      ...runtime.approvalRules,
    ]);
  }, [approvalGate, runtime.sessionApprovalGrants, runtime.approvalRules]);

  const queueToolApproval = useCallback(
    (event: Parameters<typeof runtime.recordBackendToolCall>[0]) => {
      if (["connector-call", "connector-action"].includes(event.approval.action.split(/\s+/)[0]) || isLocalComputerTool(event.tool, event.arguments)) return;
      if (approvalGate.register(event.approval))
        runtime.recordBackendToolCall(event);
    },
    [approvalGate, runtime.recordBackendToolCall],
  );

  useEffect(() => {
    setHostedBrowserSnapshot(null);
    setHostedBrowserError(null);
  }, [hostedWorkspaceId, activeAgentId]);

  const openHostedBrowser = async (url: string) => {
    if (
      !hostedWorkspaceId ||
      !activeHostedDeviceId ||
      !activeAgentId ||
      hostedComputer.node?.status !== "ready" ||
      !hostedComputer.node.keepAlive
    ) {
      throw new Error(
        "Set up this agent's hosted computer before opening its browser.",
      );
    }
    setHostedBrowserPhase("preparing");
    setHostedBrowserError(null);
    try {
      const prepared = await prepareRuntimeHostedBrowser({
        workspaceId: hostedWorkspaceId,
        agentId: activeAgentId,
        deviceId: activeHostedDeviceId,
        url,
      });
      if (!prepared)
        throw new Error(
          "Hosted browser navigation requires the desktop runtime.",
        );
      queueToolApproval({
        callId: prepared.approval.id,
        tool: "cloud-browser",
        arguments: JSON.stringify({
          url: prepared.proposal.url,
          computer: activeAgentId,
        }),
        approval: prepared.approval,
      });
      setHostedBrowserPhase("awaiting-approval");
      if (
        (await approvalGate.waitForDecision(prepared.approval)) !== "granted"
      ) {
        throw new Error("Hosted browser navigation was denied.");
      }
      setHostedBrowserPhase("opening");
      const resolution: ApprovalResolutionRequest = {
        request: prepared.approval,
        decision: "once",
        decidedAt: new Date().toISOString(),
        confirmationText: prepared.approval.confirmationPhrase,
      };
      const snapshot = await navigateRuntimeHostedBrowser(
        prepared.proposal,
        resolution,
      );
      if (!snapshot)
        throw new Error(
          "Hosted browser navigation requires the desktop runtime.",
        );
      setHostedBrowserSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      setHostedBrowserError(
        error instanceof Error
          ? error.message
          : "The hosted browser is unavailable.",
      );
      throw error;
    } finally {
      setHostedBrowserPhase("idle");
    }
  };

  const refreshHostedBrowser = async () => {
    if (!hostedWorkspaceId || !activeHostedDeviceId || !activeAgentId)
      return null;
    setHostedBrowserPhase("refreshing");
    setHostedBrowserError(null);
    try {
      const snapshot = await snapshotRuntimeHostedBrowser({
        workspaceId: hostedWorkspaceId,
        agentId: activeAgentId,
        deviceId: activeHostedDeviceId,
      });
      if (!snapshot)
        throw new Error(
          "Hosted browser inspection requires the desktop runtime.",
        );
      setHostedBrowserSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      setHostedBrowserError(
        error instanceof Error
          ? error.message
          : "The hosted browser is unavailable.",
      );
      throw error;
    } finally {
      setHostedBrowserPhase("idle");
    }
  };

  const executor = useMemo(
    () =>
      createDesktopToolExecutor(approvalGate, {
        connectorIds: connectorAccessRef.current.ids,
        connectorAccessCurrent: (connectorId) => connectorAccessRef.current.workspaceId === activeWorkspaceId
          && connectorAccessRef.current.agentId === activeAgentId && connectorAccessRef.current.ids.includes(connectorId),
        workspaceId: activeWorkspaceId,
        localComputerCurrent: () => localComputerRef.current,
        shouldCancel: () => cancelRequestedRef.current,
        onExecuting: (approval, tool) => executionActivityRef.current(approval.id, tool),
        ...(activeWorkspaceId && activeAgentId
          ? {
              localComputer: {
                workspaceId: activeWorkspaceId,
                agentId: activeAgentId,
                ready: localComputer.node?.lifecycle === "ready",
                generation: localComputer.node?.generation,
                controller: localComputer.node?.controller,
              },
            }
          : {}),
        ...(hostedWorkspaceId && activeHostedDeviceId && activeAgentId
          ? {
              hostedComputer: {
                workspaceId: hostedWorkspaceId,
                agentId: activeAgentId,
                deviceId: activeHostedDeviceId,
                ready:
                  hostedComputer.node?.status === "ready" &&
                  hostedComputer.node.keepAlive,
              },
            }
          : {}),
        onHostedBrowserSnapshot: setHostedBrowserSnapshot,
        queueApproval: (approval, tool, argumentsJson) => {
          if (approvalGate.register(approval)) runtime.recordBackendToolCall({
            callId: approval.id,
            tool,
            arguments: argumentsJson,
            approval,
          });
        },
      }),
    [
      approvalGate,
      activeWorkspaceId,
      activeAgentId,
      runtime.agents,
      localComputer.node?.lifecycle,
      hostedWorkspaceId,
      activeHostedDeviceId,
      hostedComputer.node?.status,
      hostedComputer.node?.keepAlive,
      queueToolApproval,
    ],
  );

  const cancelApprovals = useCallback(() => {
    approvalGate.cancelPending();
    runtime.clearBackendToolApprovals();
  }, [approvalGate, runtime.clearBackendToolApprovals]);
  const durableConversation = useDurableConversation({
    workspaceId: activeWorkspaceId,
    threadId,
  });
  const agent = useNativeAgent({
    computer: activeWorkspaceId && activeAgentId ? { workspaceId: activeWorkspaceId, agentId: activeAgentId } : undefined,
    providers: runtime.backendProviders,
    activeProviderId: runtime.connectedAgentBackend?.id,
    models: runtime.selectableModels,
    threadId,
    createDurableRunWriter: createDesktopDurableRunWriter,
    loadConversation: loadDesktopConversation,
    execute: executor,
    authorize: async (approval) => {
      if ((await approvalGate.waitForDecision(approval)) !== "granted") {
        throw new Error("Antigravity permission was denied.");
      }
    },
    shouldCancel: () => cancelRequestedRef.current,
    onCancel: () => {
      cancelRequestedRef.current = true;
      cancelApprovals();
    },
    onToolCall: queueToolApproval,
  });
  const voiceProvider = useMemo(() => createBrowserSpeechProvider(), []);
  executionActivityRef.current = agent.markToolExecuting;
  scopeResetRef.current = () => {
    const attemptId = agent.state.currentAttemptId;
    if (!agent.state.running || !attemptId || cancelledScopeAttemptRef.current === attemptId) return;
    cancelledScopeAttemptRef.current = attemptId;
    cancelRequestedRef.current = true;
    void agent.cancel();
  };
  const voice = useVoice(voiceProvider, onDictation, {
    disabled: false,
    onCancel: onVoiceCancel,
  });

  return {
    runtime,
    agent,
    durableConversation,
    voice,
    localComputer,
    hostedComputer,
    hostedBrowser: {
      snapshot: hostedBrowserSnapshot,
      opening: hostedBrowserPhase !== "idle",
      phase: hostedBrowserPhase,
      error: hostedBrowserError,
      open: openHostedBrowser,
      refresh: refreshHostedBrowser,
    },
    stopCurrentWork: async () => {
      if (!agent.state.running) return false;
      cancelRequestedRef.current = true;
      const computer = localComputerRef.current;
      // Native cancellation revokes admitted computer operations even while the
      // provider is stopping or waiting for a tool result.
      const cancellation = computer?.ready && computer.generation !== undefined && computer.controller === "agent"
        ? cancelRuntimeLocalComputer({ workspaceId: computer.workspaceId, agentId: computer.agentId, expectedGeneration: computer.generation })
        : Promise.resolve(null);
      const results = await Promise.allSettled([agent.cancel(), cancellation]);
      await localComputer.refresh().catch(() => undefined);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return true;
    },
    resetCancellation: () => {
      cancelRequestedRef.current = false;
    },
    beginConnectorTurn: async () => {
      const saved = activeWorkspaceId ? await listRuntimeMcpServerConfigurations(activeWorkspaceId) : [];
      if (connectorAccessRef.current.workspaceId !== activeWorkspaceId || connectorAccessRef.current.agentId !== activeAgentId) throw new Error("The active conversation changed. Send your message again.");
      const remoteIds = remoteConnectors.filter((preset) => saved?.some((server) => server.id === remoteConnectorServerId(preset.id) && !server.disabled)).map((preset) => preset.id);
      const ids = chatConnectorIds(remoteIds, runtime.connectorManifests);
      turnConnectorsRef.current = { workspaceId: activeWorkspaceId, agentId: activeAgentId, ids: remoteIds };
      connectorAccessRef.current = { workspaceId: activeWorkspaceId, agentId: activeAgentId, ids };
      return ids;
    },
    endConnectorTurn: () => {
      if (turnConnectorsRef.current.workspaceId === activeWorkspaceId && turnConnectorsRef.current.agentId === activeAgentId) {
        turnConnectorsRef.current.ids = [];
      }
      if (connectorAccessRef.current.workspaceId === activeWorkspaceId && connectorAccessRef.current.agentId === activeAgentId) {
        connectorAccessRef.current.ids = [];
      }
    },
  };
}
