import type {
  LocalBrowserSnapshot,
  LocalComputerApplication,
  LocalComputerController,
  LocalComputerSnapshot,
  LocalComputerTarget,
  LocalComputerLifecycleAction,
} from "@fable/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  historyRuntimeLocalBrowser,
  keyRuntimeLocalBrowser,
  launchRuntimeLocalComputerApplication,
  listRuntimeLocalComputerFiles,
  loadRuntimeLocalComputer,
  navigateRuntimeLocalBrowser,
  pointRuntimeLocalBrowser,
  previewRuntimeLocalComputerFile,
  provisionRuntimeLocalComputer,
  setRuntimeLocalComputerController,
  snapshotRuntimeLocalBrowser,
  openRuntimeLocalComputerViewer,
  closeRuntimeLocalComputerViewer,
  prepareRuntimeBuiltinComputer,
} from "../runtime";
import { changeComputerLifecycle } from "../lib/computer-lifecycle";

type BrowserAction =
  | { kind: "lifecycle"; action: LocalComputerLifecycleAction }
  | { kind: "navigate"; url: string }
  | { kind: "controller"; controller: "agent" | "human" }
  | { kind: "pointer"; x: number; y: number; action: "click" | "scroll"; deltaY?: number }
  | { kind: "key"; key: string }
  | { kind: "history"; direction: "back" | "forward" }
  | { kind: "application"; application: LocalComputerApplication };

export function useLocalComputer({ workspaceId, agentId, viewing = false, thumbnailEnabled = true }: {
  workspaceId?: string;
  agentId: string;
  /** Temporary trusted UI frame viewer. A streaming viewer does not need this. */
  viewing?: boolean;
  thumbnailEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const instanceId = useId();
  const scopeCounter = useRef(0);
  const scope = useMemo(() => ({
    key: `${workspaceId ?? "unavailable"}:${agentId}`,
    id: `${instanceId}:${++scopeCounter.current}`,
    target: workspaceId ? { workspaceId, agentId } as LocalComputerTarget : null,
    epoch: 0,
    generation: -1,
    frameRequest: 0,
    previewRequest: 0,
    node: null as LocalComputerSnapshot | null,
    frame: null as LocalBrowserSnapshot | null,
    pending: false,
    disconnected: false,
  }), [workspaceId, agentId, instanceId]);
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;
  const demand = useRef({ viewing, thumbnailEnabled });
  demand.current = { viewing, thumbnailEnabled };
  const [, updateProjection] = useState(0);
  const queryKey = ["local-computer", scope.key, scope.id] as const;
  const browserQueryKey = ["local-computer-browser", scope.key, scope.id] as const;
  const filesQueryKey = ["local-computer-files", scope.key, scope.id] as const;
  const current = (epoch = scope.epoch) => currentScope.current === scope && epoch === scope.epoch;
  const clearFrame = () => {
    scope.frame = null;
    scope.frameRequest += 1;
    queryClient.setQueryData(browserQueryKey, null);
  };
  const fence = () => {
    scope.epoch += 1;
    scope.previewRequest += 1;
    clearFrame();
    queryClient.setQueryData(filesQueryKey, null);
    return scope.epoch;
  };
  const acceptNode = (node: LocalComputerSnapshot | null) => {
    if (!node) {
      if (scope.node) fence();
      scope.node = null;
      clearFrame();
      return null;
    }
    if (node.workspaceId !== workspaceId || node.agentId !== agentId || node.generation < scope.generation)
      return scope.node;
    if (node.generation > scope.generation || scope.node?.computerId !== node.computerId) fence();
    scope.generation = node.generation;
    scope.node = node;
    scope.disconnected = false;
    if (!node.browserActive) clearFrame();
    return node;
  };
  const acceptFrame = (frame: LocalBrowserSnapshot | null) => {
    if (!frame) { clearFrame(); return null; }
    if (!scope.node || frame.computerId !== scope.node.computerId || frame.generation < scope.generation)
      return scope.frame;
    if (frame.generation > scope.generation) fence();
    if (scope.frame && frame.generation === scope.frame.generation && frame.updatedAt < scope.frame.updatedAt)
      return scope.frame;
    scope.generation = frame.generation;
    scope.node = { ...scope.node, controller: frame.controller, generation: frame.generation, leaseExpiresAt: frame.leaseExpiresAt };
    queryClient.setQueryData(queryKey, scope.node);
    // Human-only input can be viewed in the trusted viewer, never reused as a
    // conversation thumbnail after that viewer is closed.
    scope.frame = !demand.current.viewing && frame.controller !== "agent" ? { ...frame, previewDataUrl: "" } : frame;
    return scope.frame;
  };
  const readNode = async () => {
    if (!scope.target || scope.pending) return scope.node;
    const epoch = scope.epoch;
    try {
      const node = await loadRuntimeLocalComputer(scope.target);
      return current(epoch) ? acceptNode(node) : scope.node;
    } catch (error) {
      if (!current(epoch)) return scope.node;
      scope.disconnected = true;
      fence();
      throw error;
    }
  };
  const readFrame = async () => {
    if (!scope.target || !scope.node?.browserActive || scope.pending || scope.disconnected) return null;
    const epoch = scope.epoch;
    const request = ++scope.frameRequest;
    try {
      const frame = await snapshotRuntimeLocalBrowser(scope.target);
      return current(epoch) && request === scope.frameRequest ? acceptFrame(frame) : scope.frame;
    } catch (error) {
      if (!current(epoch) || request !== scope.frameRequest) return scope.frame;
      scope.disconnected = true;
      fence();
      throw error;
    }
  };
  const computer = useQuery({ queryKey, queryFn: readNode, enabled: Boolean(scope.target), retry: false, gcTime: 0, refetchInterval: scope.target ? 2_000 : false });
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["local-computer"] }); };
    window.addEventListener("fable-builtin-plugins-changed", refresh);
    return () => window.removeEventListener("fable-builtin-plugins-changed", refresh);
  }, [queryClient]);
  const node = scope.disconnected ? null : computer.data ?? null;
  const leaseExpired = node?.controller === "human" && (!node.leaseExpiresAt || !Number.isFinite(Date.parse(node.leaseExpiresAt)) || Date.parse(node.leaseExpiresAt) <= Date.now());
  const effectiveController: LocalComputerController = leaseExpired ? "paused" : node?.controller ?? "paused";
  const frameDemand = Boolean(scope.target && node?.browserActive && (viewing || thumbnailEnabled && effectiveController === "agent"));
  const browser = useQuery({
    queryKey: browserQueryKey, queryFn: readFrame, enabled: frameDemand, retry: false, gcTime: 0,
    refetchInterval: frameDemand ? viewing ? 1_500 : 15_000 : false,
    refetchOnWindowFocus: false,
  });
  const files = useQuery({
    queryKey: filesQueryKey,
    queryFn: async () => {
      const epoch = scope.epoch;
      const result = scope.target ? await listRuntimeLocalComputerFiles(scope.target) : null;
      return current(epoch) && (!scope.node || result?.computerId === scope.node.computerId) ? result : null;
    },
    enabled: false, retry: false, gcTime: 0,
  });
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      scope.epoch += 1;
      scope.frame = null;
      if (currentScope.current === scope) currentScope.current = null;
    };
  }, [scope]);
  useEffect(() => {
    if (viewing) return;
    scope.frameRequest += 1;
    if (!thumbnailEnabled || scope.frame?.controller !== "agent") {
      scope.frame = null;
      queryClient.setQueryData(browserQueryKey, null);
    }
  }, [scope, viewing, thumbnailEnabled, queryClient]);
  useEffect(() => {
    if (node?.controller !== "human" || !node.leaseExpiresAt || leaseExpired) return;
    const delay = Math.max(0, Date.parse(node.leaseExpiresAt) - Date.now());
    const timer = window.setTimeout(() => {
      if (currentScope.current !== scope) return;
      fence();
      updateProjection((value) => value + 1);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [scope, node?.controller, node?.leaseExpiresAt, leaseExpired, queryClient]);

  const filePreview = useMutation({
    mutationFn: async (input: { scope: typeof scope; request: number; epoch: number; path: string }) => {
      if (!input.scope.target) throw new Error("The private file is unavailable.");
      const preview = await previewRuntimeLocalComputerFile({ ...input.scope.target, path: input.path });
      return current(input.epoch) && input.scope === scope && input.request === scope.previewRequest ? preview : null;
    },
  });
  const filePreviewMatchesScope = filePreview.variables?.scope === scope && filePreview.variables.epoch === scope.epoch && filePreview.variables.request === scope.previewRequest;
  const action = useMutation({
    mutationFn: async (input: { scope: typeof scope; action: BrowserAction | { kind: "provision" } }) => {
      if (input.scope !== scope || !current() || !scope.target) throw new Error("Choose an agent before using its computer.");
      if (scope.pending) throw new Error("Wait for the current computer action to finish.");
      if (input.action.kind !== "provision" && (scope.disconnected || !scope.node)) throw new Error("Reconnect to the computer before continuing.");
      const expectedGeneration = scope.generation;
      scope.pending = true;
      const epoch = fence();
      try {
        const request = { ...scope.target, expectedGeneration };
        const operation = input.action;
        if (operation.kind === "provision") {
          const result = await provisionRuntimeLocalComputer(scope.target);
          if (!current(epoch)) return null;
          if (!result) throw new Error("Computer setup requires the desktop app.");
          queryClient.setQueryData(queryKey, acceptNode(result));
          return null;
        }
        if (operation.kind === "lifecycle") {
          const result = await changeComputerLifecycle({ ...request, action: operation.action });
          if (!current(epoch)) return null;
          queryClient.setQueryData(queryKey, acceptNode(result));
          return null;
        }
        const result = operation.kind === "navigate" ? await navigateRuntimeLocalBrowser({ ...request, url: operation.url })
          : operation.kind === "controller" ? await setRuntimeLocalComputerController({ ...request, controller: operation.controller })
            : operation.kind === "pointer" ? await pointRuntimeLocalBrowser({ ...request, x: operation.x, y: operation.y, action: operation.action, deltaY: operation.deltaY })
              : operation.kind === "key" ? await keyRuntimeLocalBrowser({ ...request, key: operation.key })
                : operation.kind === "history" ? await historyRuntimeLocalBrowser({ ...request, direction: operation.direction })
                  : await launchRuntimeLocalComputerApplication({ ...request, application: operation.application });
        if (!current(epoch)) return null;
        if (!result || result.computerId !== scope.node?.computerId || result.generation < scope.generation)
          throw new Error("The computer did not return a current observation. Reconnect to continue.");
        const accepted = acceptFrame(result);
        queryClient.setQueryData(browserQueryKey, accepted);
        return accepted;
      } catch (error) {
        if (current(epoch)) { scope.disconnected = true; fence(); }
        throw error;
      } finally {
        scope.pending = false;
        if (currentScope.current === scope) void queryClient.invalidateQueries({ queryKey, exact: true });
      }
    },
  });
  const actionMatchesScope = action.variables?.scope === scope;
  const viewer = useMutation({
    mutationFn: async () => {
      if (!current() || !scope.target || !scope.node?.browserActive) throw new Error("Start this computer before opening its screen.");
      const epoch = scope.epoch;
      const result = await openRuntimeLocalComputerViewer({ ...scope.target, expectedGeneration: scope.generation });
      if (!result) throw new Error("The computer viewer requires the native Fable app.");
      if (!current(epoch)) { await closeRuntimeLocalComputerViewer(result.sessionId); return null; }
      return result;
    },
  });
  const refresh = async () => {
    if (scope.pending) throw new Error("Wait for the current computer action to finish.");
    fence();
    action.reset();
    // Cancel observer writes as well as fencing the uncancellable native work.
    await queryClient.cancelQueries({ queryKey, exact: true });
    await queryClient.cancelQueries({ queryKey: browserQueryKey, exact: true });
    if (!current()) return null;
    const status = await computer.refetch({ throwOnError: true });
    if (!current() || !status.data?.browserActive) return null;
    return (await browser.refetch({ throwOnError: true })).data ?? null;
  };
  const invokeAction = (operation: BrowserAction | { kind: "provision" }) => action.mutateAsync({ scope, action: operation });
  const actionError = actionMatchesScope && action.error instanceof Error ? action.error.message : null;
  const recoveryError = computer.error instanceof Error ? computer.error.message : browser.error instanceof Error ? browser.error.message : actionError;
  const snapshot = scope.disconnected || leaseExpired || scope.pending ? null : browser.data?.generation === scope.generation
    ? !viewing && browser.data.controller !== "agent" ? { ...browser.data, previewDataUrl: "" } : browser.data : null;
  return {
    scopeKey: scope.key,
    available: Boolean(scope.target),
    node: node && leaseExpired ? { ...node, controller: "paused" as const } : node,
    controller: effectiveController,
    paused: effectiveController === "paused",
    snapshot,
    files: files.data ?? null,
    filesLoading: files.isFetching,
    filesError: files.error instanceof Error ? files.error.message : null,
    filePreview: filePreviewMatchesScope ? filePreview.data ?? null : null,
    filePreviewLoading: filePreviewMatchesScope && filePreview.isPending,
    filePreviewError: filePreviewMatchesScope && filePreview.error instanceof Error ? filePreview.error.message : null,
    loading: computer.isLoading,
    provisioning: actionMatchesScope && action.isPending && action.variables.action.kind === "provision",
    browserBusy: actionMatchesScope && action.isPending,
    recoveryNeeded: recoveryError !== null || scope.disconnected,
    error: recoveryError ?? (viewer.error instanceof Error ? viewer.error.message : null),
    openViewer: () => viewer.mutateAsync(),
    provision: () => invokeAction({ kind: "provision" }),
    prepareForTool: async (tool: string) => {
      if (!scope.target || scope.pending || scope.disconnected) throw new Error("Refresh the agent's computer before continuing.");
      const expected = scope.epoch;
      const initial = await loadRuntimeLocalComputer(scope.target);
      if (!current(expected) || !initial) throw new Error("The computer scope changed before startup.");
      acceptNode(initial);
      queryClient.setQueryData(queryKey, initial);
      if (initial.lifecycle === "ready") return initial;
      const startupEpoch = scope.epoch;
      const plugin = tool.startsWith("local-browser") || (tool === "computer-artifact" && !initial.plugins?.computer) ? "browser" : "computer";
      const result = await prepareRuntimeBuiltinComputer(scope.target, plugin, initial.generation);
      if (!current(startupEpoch) || !result) throw new Error("The computer scope changed during startup. Refresh before continuing.");
      acceptNode(result);
      queryClient.setQueryData(queryKey, result);
      return result;
    },
    stop: () => invokeAction({ kind: "lifecycle", action: "stop" }),
    restart: () => invokeAction({ kind: "lifecycle", action: "restart" }),
    updateSystem: () => invokeAction({ kind: "lifecycle", action: "update" }),
    navigate: (url: string) => invokeAction({ kind: "navigate", url }),
    refresh,
    refreshFiles: () => files.refetch({ throwOnError: true }).then((result) => result.data ?? null),
    previewFile: (path: string) => { filePreview.reset(); return filePreview.mutateAsync({ scope, request: ++scope.previewRequest, epoch: scope.epoch, path }); },
    closeFilePreview: () => { scope.previewRequest += 1; filePreview.reset(); updateProjection((value) => value + 1); },
    takeControl: () => invokeAction({ kind: "controller", controller: "human" }),
    returnControl: () => invokeAction({ kind: "controller", controller: "agent" }),
    resume: async () => { await refresh(); return invokeAction({ kind: "controller", controller: "agent" }); },
    click: (x: number, y: number) => invokeAction({ kind: "pointer", x, y, action: "click" }),
    scroll: (x: number, y: number, deltaY: number) => invokeAction({ kind: "pointer", x, y, action: "scroll", deltaY }),
    key: (key: string) => invokeAction({ kind: "key", key }),
    goBack: () => invokeAction({ kind: "history", direction: "back" }),
    goForward: () => invokeAction({ kind: "history", direction: "forward" }),
    launchApplication: (application: LocalComputerApplication) => invokeAction({ kind: "application", application }),
  };
}
