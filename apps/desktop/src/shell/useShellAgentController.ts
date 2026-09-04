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
  useDurableConversation,
} from "../hooks/useDurableConversation";
import { useShellRuntime } from "../hooks/useShellRuntime";
import { useVoice } from "../hooks/useVoice";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import {
  navigateRuntimeHostedBrowser,
  prepareRuntimeHostedBrowser,
  snapshotRuntimeHostedBrowser,
} from "../runtime";

export function useShellAgentController({
  onDictation,
  onVoiceCancel,
  threadId,
}: {
  onDictation: (transcript: string) => void;
  onVoiceCancel: () => void;
  threadId?: string;
}) {
  const approvalGate = useMemo(() => createApprovalGate(), []);
  const runtime = useShellRuntime({ approvalGate });
  const cancelRequestedRef = useRef(false);
  const [hostedBrowserSnapshot, setHostedBrowserSnapshot] =
    useState<HostedBrowserSnapshot | null>(null);
  const [hostedBrowserPhase, setHostedBrowserPhase] = useState<
    "idle" | "preparing" | "awaiting-approval" | "opening" | "refreshing"
  >("idle");
  const [hostedBrowserError, setHostedBrowserError] = useState<string | null>(
    null,
  );

  const activeWorkspaceId =
    !runtime.accountWorkspacePending &&
    runtime.accountWorkspaceStatus.accountBound &&
    (runtime.accountWorkspaceStatus.state === "ready" ||
      runtime.accountWorkspaceStatus.state === "offline") &&
    runtime.accountWorkspaceStatus.activeWorkspace.source === "local"
      ? runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId
      : undefined;
  const activeAgentId = runtime.activeAgentId ?? runtime.agents[0]?.id;
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
  });
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
        "Set up this teammate's hosted computer before opening its browser.",
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
        workspaceId: activeWorkspaceId,
        ...(activeWorkspaceId && activeAgentId
          ? {
              localComputer: {
                workspaceId: activeWorkspaceId,
                agentId: activeAgentId,
                ready: localComputer.node?.lifecycle === "ready",
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
        queueApproval: (approval, tool, argumentsJson) =>
          queueToolApproval({
            callId: approval.id,
            tool,
            arguments: argumentsJson,
            approval,
          }),
      }),
    [
      approvalGate,
      activeWorkspaceId,
      activeAgentId,
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
    providers: runtime.backendProviders,
    activeProviderId: runtime.connectedAgentBackend?.id,
    models: runtime.selectableModels,
    threadId,
    createDurableRunWriter: createDesktopDurableRunWriter,
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
      await agent.cancel();
      return true;
    },
    resetCancellation: () => {
      cancelRequestedRef.current = false;
    },
  };
}
