import type { LocalComputerTarget } from "@mivlet/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cancelRuntimeLocalComputer, previewRuntimeLocalComputerFile, stopRuntimeAppControl } from "../runtime/domains/local-computer";
import { getLocalComputerReads, localComputerDataScope } from "./local-computer-reads";

/** Native permission never lives in this hook. Shared reads are display data only. */
export function useLocalComputer({ workspaceId, agentId, executionOwner = true }: { workspaceId?: string; agentId: string; executionOwner?: boolean }) {
  const queries = useQueryClient();
  const instance = useId();
  const dataScope = localComputerDataScope();
  const scope = useMemo(() => {
    const target = workspaceId ? { workspaceId, agentId } as LocalComputerTarget : null;
    return { key: `${dataScope.id}:${workspaceId}:${agentId}:${instance}`, target, epoch: 0, preview: 0,
      reads: getLocalComputerReads(queries, target, dataScope) };
  }, [workspaceId, agentId, instance, queries, dataScope.id]);
  const shared = scope.reads;
  const active = useRef<typeof scope | null>(scope); active.current = scope;
  const [, redraw] = useState(0);
  const current = (epoch = scope.epoch) => active.current === scope && scope.epoch === epoch && shared.current();
  const subscribe = useCallback((notify: () => void) => shared.subscribe(instance, notify), [shared, instance]);
  const readVersion = useSyncExternalStore(subscribe, () => shared.version * 2 + Number(shared.leader() === instance));
  const isLeader = readVersion % 2 === 1;
  const computer = useQuery({ queryKey: shared.queryKey, queryFn: async () => {
    const epoch = shared.epoch;
    const result = await shared.read();
    // Stop and development remounts fence every consumer, including the poller.
    if (shared.current() && epoch !== shared.epoch && !shared.disconnected && shared.consumers.size) return shared.node ?? shared.read();
    return result;
  }, enabled: Boolean(scope.target), retry: false, gcTime: 0, staleTime: Infinity,
    // One elected observer polls; ownership moves when that view closes.
    // Hidden windows do not suspend execution/control refreshes.
    refetchIntervalInBackground: shared.node?.control.status === "active" || shared.node?.control.status === "connecting",
    refetchInterval: isLeader ? (() => shared.node?.control.status === "active" || shared.node?.control.status === "connecting" ? 2_000 : 30_000) : false });
  useEffect(() => {
    if (!isLeader) return;
    const refresh = () => { shared.invalidateFiles(); void queries.invalidateQueries({ queryKey: shared.queryKey, exact: true }, { cancelRefetch: false }); };
    window.addEventListener("mivlet-builtin-plugins-changed", refresh);
    return () => window.removeEventListener("mivlet-builtin-plugins-changed", refresh);
  }, [queries, shared, isLeader]);
  useEffect(() => {
    active.current = scope;
    if (executionOwner) shared.owners.add(instance);
    return () => {
      scope.epoch++; scope.preview++;
      if (active.current === scope) active.current = null;
      if (executionOwner) shared.owners.delete(instance);
      if (executionOwner && !shared.owners.size && scope.target && shared.node?.control.status === "active") {
        void cancelRuntimeLocalComputer({ ...scope.target, expectedGeneration: shared.node.generation }).catch(() => undefined);
      }
    };
  }, [scope, shared, instance, executionOwner]);
  const files = useQuery({ queryKey: shared.filesKey, enabled: false, retry: false, gcTime: 0, queryFn: () => shared.readFiles() });
  const preview = useMutation({ mutationFn: async (input: { scope: typeof scope; epoch: number; fileEpoch: number; request: number; path: string }) => {
    if (!input.scope.target) throw new Error("Choose an agent before opening files.");
    const result = await previewRuntimeLocalComputerFile({ ...input.scope.target, path: input.path });
    return input.scope === scope && current(input.epoch) && input.fileEpoch === shared.fileEpoch && input.request === scope.preview ? result : null;
  } });
  const refresh = async () => {
    const epoch = scope.epoch;
    const result = await shared.read();
    if (current(epoch)) queries.setQueryData(shared.queryKey, result ?? shared.node);
    return result;
  };
  const stop = async () => {
    shared.epoch++; shared.invalidateFiles(); scope.preview++;
    if (shared.node) {
      shared.node = { ...shared.node, controller: "paused", control: { ...shared.node.control, status: "idle", requestId: null, message: "Stopping computer input…" } };
      queries.setQueryData(shared.queryKey, shared.node);
    }
    await stopRuntimeAppControl();
    const result = await refresh();
    if (active.current === scope) redraw(v => v + 1);
    return result;
  };
  const node = !shared.current() || shared.disconnected ? null : computer.data ?? null;
  const previewCurrent = preview.variables?.scope === scope && preview.variables.epoch === scope.epoch && preview.variables.fileEpoch === shared.fileEpoch && preview.variables.request === scope.preview;
  const error = computer.error;
  return {
    scopeKey: scope.key, available: Boolean(scope.target), node, controller: node?.controller ?? "paused", paused: node?.controller !== "agent",
    loading: computer.isLoading, busy: node?.control.status === "connecting", error: shared.failure ?? (error instanceof Error ? error.message : node?.message ?? null),
    stop, refresh,
    files: shared.current() ? files.data ?? null : null, filesLoading: files.isFetching, filesError: files.error instanceof Error ? files.error.message : null,
    refreshFiles: () => files.refetch({ throwOnError: true, cancelRefetch: false }).then(r => r.data ?? null),
    filePreview: previewCurrent ? preview.data ?? null : null, filePreviewLoading: previewCurrent && preview.isPending,
    filePreviewError: previewCurrent && preview.error instanceof Error ? preview.error.message : null,
    previewFile: (path: string) => { preview.reset(); return preview.mutateAsync({ scope, epoch: scope.epoch, fileEpoch: shared.fileEpoch, request: ++scope.preview, path }); },
    closeFilePreview: () => { scope.preview++; preview.reset(); redraw(v => v + 1); },
    prepareForTool: async (tool: string) => {
      const epoch = scope.epoch; const sharedEpoch = shared.epoch;
      const node = await refresh();
      if (!current(epoch) || sharedEpoch !== shared.epoch || shared.disconnected) throw new Error("Computer status changed. Refresh it before trying again.");
      if (!node) throw new Error(scope.target ? "Computer status is unavailable. Refresh it in the Computer panel." : "Open a local workspace before using Computer Use.");
      if (!node.plugins) throw new Error("Computer capability information is unavailable. Restart the desktop app to load its current runtime.");
      if (!node.plugins.computer) throw new Error("Enable Computer Use in Plugins first.");
      if (tool.startsWith("local-app-") || tool.startsWith("local-desktop-")) {
        if (!node.runtimeAvailable) throw new Error(node.message || "The bundled Windows computer runtime is unavailable.");
      }
      return node;
    },
  };
}
