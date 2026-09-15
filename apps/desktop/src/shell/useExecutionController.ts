import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LocalComputerSnapshot } from "@fable/protocol";
import { useHostedBrowserController } from "../hooks/useHostedBrowserController";
import { useHostedComputer } from "../hooks/useHostedComputer";
import { useLocalComputer } from "../hooks/useLocalComputer";
import { useNativeAgent } from "../hooks/useNativeAgent";
import {
  createDesktopDurableRunWriter,
  loadDesktopConversation,
} from "../hooks/useDurableConversation";
import { isCollaborationTool } from "@fable/connectors/native-api/tools";
import {
  createDesktopToolExecutor,
  type DesktopToolExecutorOptions,
} from "../lib/desktop-tool-runtime";
import { chatConnectorIds, chatConnectorTools } from "../lib/connector-chat";
import { isLocalComputerTool } from "../lib/computer-tools";
import { resolveHostedComputerScope } from "../lib/hosted-computer-scope";
import { modelsForProvider } from "../lib/provider-models";
import { cancelRuntimeLocalComputer } from "../runtime/domains/local-computer";

export function useExecutionController({
  runtime,
  approvalGate,
  wrapExecutor,
  onApproval,
  attributeHistory,
  threadId,
  executionAgentId,
  executionProviderId,
}: {
  runtime: import("../hooks/useShellRuntime").ShellRuntime;
  approvalGate: import("@fable/connectors/native-api/tool-executor").ToolApprovalGate;
  wrapExecutor: (
    executor: import("@fable/connectors").ToolExecutor,
  ) => import("@fable/connectors").ToolExecutor;
  onApproval: (id: string) => void;
  attributeHistory: NonNullable<
    import("../hooks/useNativeAgent").UseNativeAgentOptions["attributeHistory"]
  >;
  threadId?: string;
  executionAgentId?: string;
  executionProviderId?: string;
}) {
  const executionActivityRef = useRef<
    (approvalId: string, tool: string) => void
  >(() => {});
  const cancelRequestedRef = useRef(false);
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
  const requestedAgentId = executionAgentId ?? runtime.activeAgentId;
  const activeAgentId = runtime.agents.find(
    (profile) => profile.id === requestedAgentId,
  )?.id;
  const connectorAccessRef = useRef({
    workspaceId: activeWorkspaceId,
    agentId: activeAgentId,
    ids: [] as string[],
    accounts: {} as Record<string, string>,
  });
  const turnConnectorsRef = useRef({
    workspaceId: activeWorkspaceId,
    agentId: activeAgentId,
    ids: [] as string[],
    routes: {} as Record<string, string>,
  });
  const turn = turnConnectorsRef.current;
  connectorAccessRef.current = {
    workspaceId: activeWorkspaceId,
    agentId: activeAgentId,
    ids:
      turn.workspaceId === activeWorkspaceId && turn.agentId === activeAgentId
        ? chatConnectorIds([], runtime.connectorManifests).filter(
            (id) =>
              turn.ids.includes(id) &&
              turn.routes[id] ===
                (runtime.connectorManifests.find(
                  (manifest) => manifest.id === id,
                )?.connectionRoute ?? "native"),
          )
        : [],
    accounts: Object.fromEntries(
      runtime.connectorManifests.flatMap((manifest) =>
        manifest.account?.id ? [[manifest.id, manifest.account.id]] : [],
      ),
    ),
  };
  const hostedScope = resolveHostedComputerScope(runtime.accountWorkspaceStatus);
  const hostedWorkspaceId = hostedScope?.workspaceId ?? null;
  const activeHostedDeviceId = hostedScope?.deviceId ?? null;

  const localComputer = useLocalComputer({
    workspaceId: activeWorkspaceId,
    agentId: activeAgentId ?? "agent-unavailable",
  });
  const localComputerRef =
    useRef<DesktopToolExecutorOptions["localComputer"]>(undefined);
  const computerTurnRef = useRef<{
    workspaceId: string;
    agentId: string;
    generation: number;
  } | null>(null);
  localComputerRef.current =
    activeWorkspaceId && activeAgentId
      ? {
          workspaceId: activeWorkspaceId,
          agentId: activeAgentId,
          ready: localComputer.node?.lifecycle === "ready",
          generation: localComputer.node?.generation,
          controller: localComputer.node?.controller,
        }
      : undefined;
  const hostedComputer = useHostedComputer({
    workspaceId: hostedWorkspaceId,
    agentId: activeAgentId ?? "agent-unavailable",
    deviceId: activeHostedDeviceId,
  });

  useEffect(() => {
    // Display-only: session/rule grants never auto-satisfy the execution gate.
    approvalGate.replaceStandingGrants([
      ...runtime.sessionApprovalGrants,
      ...runtime.approvalRules,
    ]);
  }, [approvalGate, runtime.sessionApprovalGrants, runtime.approvalRules]);

  const queueToolApproval = useCallback(
    (event: Parameters<typeof runtime.recordBackendToolCall>[0]) => {
      if (isCollaborationTool(event.tool)) return;
      if (
        ["connector-call", "connector-action"].includes(
          event.approval.action.split(/\s+/)[0],
        ) ||
        isLocalComputerTool(event.tool, event.arguments)
      )
        return;
      if (approvalGate.register(event.approval)) {
        onApproval(event.approval.id);
        runtime.recordBackendToolCall(event);
      }
    },
    [approvalGate, runtime.recordBackendToolCall],
  );

  const hostedBrowser = useHostedBrowserController({
    hostedWorkspaceId,
    activeHostedDeviceId,
    activeAgentId,
    hostedComputer,
    approvalGate,
    queueToolApproval,
  });
  const setHostedBrowserSnapshot = hostedBrowser.setSnapshot;

  const executor = useMemo(
    () =>
      createDesktopToolExecutor(approvalGate, {
        connectorIds: connectorAccessRef.current.ids,
        connectorAccessCurrent: (connectorId) =>
          connectorAccessRef.current.workspaceId === activeWorkspaceId &&
          connectorAccessRef.current.agentId === activeAgentId &&
          connectorAccessRef.current.ids.includes(connectorId),
        connectorAccountCurrent: (connectorId) =>
          connectorAccessRef.current.workspaceId === activeWorkspaceId &&
          connectorAccessRef.current.agentId === activeAgentId
            ? connectorAccessRef.current.accounts[connectorId]
            : undefined,
        workspaceId: activeWorkspaceId,
        localComputerCurrent: () => localComputerRef.current,
        prepareLocalComputer: async (tool) => {
          const saved = localComputerRef.current;
          if (
            !saved ||
            saved.workspaceId !== activeWorkspaceId ||
            saved.agentId !== activeAgentId
          )
            throw new Error(
              "The active agent changed before computer startup.",
            );
          const node = await localComputer.prepareForTool(tool);
          const current = localComputerRef.current;
          if (
            !current ||
            current.workspaceId !== node.workspaceId ||
            current.agentId !== node.agentId ||
            cancelRequestedRef.current
          )
            throw new Error(
              "Computer startup was interrupted. Refresh before continuing.",
            );
          localComputerRef.current = {
            workspaceId: node.workspaceId,
            agentId: node.agentId,
            ready: node.lifecycle === "ready",
            generation: node.generation,
            controller: node.controller,
          };
        },
        shouldCancel: () =>
          cancelRequestedRef.current ||
          Boolean(
            computerTurnRef.current &&
            localComputerRef.current &&
            (computerTurnRef.current.workspaceId !==
              localComputerRef.current.workspaceId ||
              computerTurnRef.current.agentId !==
                localComputerRef.current.agentId ||
              computerTurnRef.current.generation !==
                localComputerRef.current.generation),
          ),
        onExecuting: (approval, tool) =>
          executionActivityRef.current(approval.id, tool),
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
          if (approvalGate.register(approval)) {
            onApproval(approval.id);
            runtime.recordBackendToolCall({
              callId: approval.id,
              tool,
              arguments: argumentsJson,
              approval,
            });
          }
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
  }, [approvalGate, runtime.clearBackendToolApprovals]);
  const agent = useNativeAgent({
    computer:
      activeWorkspaceId && activeAgentId
        ? { workspaceId: activeWorkspaceId, agentId: activeAgentId }
        : undefined,
    contextOwner: runtime.accountWorkspaceStatus.activeContextOwner,
    providers: runtime.backendProviders,
    activeProviderId: executionProviderId ?? runtime.connectedAgentBackend?.id,
    models: executionProviderId
      ? modelsForProvider(runtime.modelOptions, executionProviderId)
      : runtime.selectableModels,
    threadId,
    createDurableRunWriter: createDesktopDurableRunWriter,
    loadConversation: loadDesktopConversation,
    execute: wrapExecutor(executor),
    recover: false,
    attributeHistory,
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
  executionActivityRef.current = agent.markToolExecuting;

  return {
    runtime,
    agent,
    localComputer,
    hostedComputer,
    hostedBrowser,
    stopCurrentWork: async (
      includePendingSubmission = false,
      computerOverride?: LocalComputerSnapshot,
    ) => {
      const hasActiveAttempt = Boolean(agent.getActiveAttemptId());
      if (!hasActiveAttempt && !includePendingSubmission) return false;
      cancelRequestedRef.current = true;
      const computer = computerOverride
        ? {
            workspaceId: computerOverride.workspaceId,
            agentId: computerOverride.agentId,
            ready: computerOverride.lifecycle === "ready",
            generation: computerOverride.generation,
            controller: computerOverride.controller,
          }
        : localComputerRef.current;
      // Native cancellation revokes admitted computer operations even while the
      // provider is stopping or waiting for a tool result.
      const cancellation =
        computer?.ready &&
        computer.generation !== undefined &&
        computer.controller === "agent"
          ? cancelRuntimeLocalComputer({
              workspaceId: computer.workspaceId,
              agentId: computer.agentId,
              expectedGeneration: computer.generation,
            })
          : Promise.resolve(null);
      const results = await Promise.allSettled([
        hasActiveAttempt ? agent.cancel() : Promise.resolve(),
        cancellation,
      ]);
      await localComputer.refresh().catch(() => undefined);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return hasActiveAttempt || includePendingSubmission;
    },
    resetCancellation: () => {
      cancelRequestedRef.current = false;
    },
    beginConnectorTurn: async () => {
      const computer = await localComputer.refresh();
      computerTurnRef.current = computer
        ? {
            workspaceId: computer.workspaceId,
            agentId: computer.agentId,
            generation: computer.generation,
          }
        : null;
      const latest = await runtime.refreshConnectorStatuses();
      if (
        connectorAccessRef.current.workspaceId !== activeWorkspaceId ||
        connectorAccessRef.current.agentId !== activeAgentId
      )
        throw new Error(
          "The active conversation changed. Send your message again.",
        );
      const manifests = latest ?? [];
      const ids = chatConnectorIds([], manifests);
      turnConnectorsRef.current = {
        workspaceId: activeWorkspaceId,
        agentId: activeAgentId,
        ids,
        routes: Object.fromEntries(
          manifests.map((manifest) => [
            manifest.id,
            manifest.connectionRoute ?? "native",
          ]),
        ),
      };
      connectorAccessRef.current = {
        workspaceId: activeWorkspaceId,
        agentId: activeAgentId,
        ids,
        accounts: Object.fromEntries(
          manifests.flatMap((manifest) =>
            manifest.account?.id ? [[manifest.id, manifest.account.id]] : [],
          ),
        ),
      };
      return { ids, tools: chatConnectorTools(ids, manifests) };
    },
    endConnectorTurn: () => {
      if (
        turnConnectorsRef.current.workspaceId === activeWorkspaceId &&
        turnConnectorsRef.current.agentId === activeAgentId
      ) {
        turnConnectorsRef.current.ids = [];
      }
      if (
        connectorAccessRef.current.workspaceId === activeWorkspaceId &&
        connectorAccessRef.current.agentId === activeAgentId
      ) {
        connectorAccessRef.current.ids = [];
        connectorAccessRef.current.accounts = {};
      }
    },
  };
}
