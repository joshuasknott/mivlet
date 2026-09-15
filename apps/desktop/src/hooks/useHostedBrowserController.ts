import { useEffect, useState } from "react";
import type {
  ApprovalResolutionRequest,
  HostedBrowserSnapshot,
} from "@fable/protocol";
import type { ToolApprovalGate } from "@fable/connectors/native-api/tool-executor";
import type { useHostedComputer } from "./useHostedComputer";
import type { ShellRuntime } from "./useShellRuntime";
import { navigateRuntimeHostedBrowser, openRuntimeHostedLiveView, prepareRuntimeHostedBrowser, snapshotRuntimeHostedBrowser, toPublicHostedBrowserSnapshot } from "../runtime/domains/hosted-computer";

export function useHostedBrowserController({
  hostedWorkspaceId,
  activeHostedDeviceId,
  activeAgentId,
  hostedComputer,
  approvalGate,
  queueToolApproval,
}: {
  hostedWorkspaceId: string | null;
  activeHostedDeviceId: string | null;
  activeAgentId?: string;
  hostedComputer: ReturnType<typeof useHostedComputer>;
  approvalGate: ToolApprovalGate;
  queueToolApproval: ShellRuntime["recordBackendToolCall"];
}) {
  const [hostedBrowserSnapshot, setHostedBrowserSnapshot] =
    useState<HostedBrowserSnapshot | null>(null);
  const [hostedBrowserPhase, setHostedBrowserPhase] = useState<
    "idle" | "preparing" | "awaiting-approval" | "opening" | "refreshing"
  >("idle");
  const [hostedBrowserError, setHostedBrowserError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setHostedBrowserSnapshot(null);
    setHostedBrowserError(null);
  }, [hostedWorkspaceId, activeHostedDeviceId, activeAgentId]);

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
      setHostedBrowserSnapshot(toPublicHostedBrowserSnapshot(snapshot));
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
      setHostedBrowserSnapshot(toPublicHostedBrowserSnapshot(snapshot));
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

  const openLiveView = async () => {
    if (!hostedWorkspaceId || !activeHostedDeviceId || !activeAgentId) {
      throw new Error("The hosted browser Live View is unavailable.");
    }
    const opened = await openRuntimeHostedLiveView({
      workspaceId: hostedWorkspaceId,
      agentId: activeAgentId,
      deviceId: activeHostedDeviceId,
    });
    if (!opened) {
      throw new Error("Hosted Live View requires the desktop runtime.");
    }
  };

  return {
    snapshot: hostedBrowserSnapshot,
    setSnapshot: (snapshot: HostedBrowserSnapshot | null) => {
      setHostedBrowserSnapshot(snapshot ? toPublicHostedBrowserSnapshot(snapshot) : null);
    },
    phase: hostedBrowserPhase,
    opening: hostedBrowserPhase !== "idle",
    error: hostedBrowserError,
    open: openHostedBrowser,
    refresh: refreshHostedBrowser,
    openLiveView,
  };
}
