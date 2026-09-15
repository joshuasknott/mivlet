import type { LocalComputerSnapshot, LocalComputerTarget } from "@mivlet/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cancelRuntimeLocalComputer, listRuntimeLocalComputerFiles, loadRuntimeLocalComputer, previewRuntimeLocalComputerFile, stopRuntimeAppControl } from "../runtime/domains/local-computer";

/** Native permission never lives in this hook. Epochs discard late UI results. */
export function useLocalComputer({ workspaceId, agentId, executionOwner = true }: { workspaceId?: string; agentId: string; executionOwner?: boolean }) {
  const queries = useQueryClient();
  const instance = useId();
  const scope = useMemo(() => ({ key: `${workspaceId}:${agentId}:${instance}`, target: workspaceId ? { workspaceId, agentId } as LocalComputerTarget : null,
    epoch: 0, request: 0, preview: 0, node: null as LocalComputerSnapshot | null, disconnected: false, failure: null as string | null,
    reading: null as { epoch: number; promise: Promise<LocalComputerSnapshot | null> } | null }), [workspaceId, agentId, instance]);
  const active = useRef<typeof scope | null>(scope); active.current = scope;
  const [, redraw] = useState(0);
  const queryKey = ["local-computer", scope.key] as const;
  const filesKey = ["local-computer-files", scope.key] as const;
  const current = (epoch = scope.epoch) => active.current === scope && scope.epoch === epoch;
  const accept = (node: LocalComputerSnapshot | null) => {
    if (!node || !scope.target) { scope.node = null; return null; }
    if (node.workspaceId !== workspaceId || node.agentId !== agentId || node.generation < (scope.node?.generation ?? 0)) return scope.node;
    if (node.generation !== scope.node?.generation) { scope.preview++; }
    scope.node = node; scope.disconnected = false; scope.failure = null; return node;
  };
  const read = async () => {
    if (!scope.target) return scope.node;
    // The query and a newly mounted execution worker can ask at the same time.
    // Share that read instead of making the earlier caller see an empty cache.
    if (scope.reading?.epoch === scope.epoch) return scope.reading.promise;
    const epoch = scope.epoch; const request = ++scope.request;
    const promise = loadRuntimeLocalComputer(scope.target).then(result =>
      current(epoch) && request === scope.request ? accept(result) : null
    ).catch((error: unknown) => {
      if (current(epoch)) { scope.disconnected = true; scope.failure = error instanceof Error ? error.message : "Computer status could not be refreshed."; scope.epoch++; scope.preview++; redraw(value => value + 1); }
      throw error;
    }).finally(() => {
      if (scope.reading?.promise === promise) scope.reading = null;
    });
    scope.reading = { epoch, promise };
    return promise;
  };
  const computer = useQuery({ queryKey, queryFn: async () => {
    const epoch = scope.epoch;
    const result = await read();
    // Query completion may arrive after Stop or React's development remount.
    // Display the current snapshot; never replace it with the cancelled read.
    if (active.current === scope && epoch !== scope.epoch && !scope.disconnected) return scope.node ?? read();
    return result;
  }, enabled: Boolean(scope.target), retry: false, gcTime: 0,
    // Preserve demand-based polling: no native image or process probes at idle.
    refetchInterval: query => query.state.data?.control.status === "active" || query.state.data?.control.status === "connecting" ? 2_000 : 30_000 });
  useEffect(() => {
    const refresh = () => { void queries.invalidateQueries({ queryKey: ["local-computer"] }); };
    window.addEventListener("mivlet-builtin-plugins-changed", refresh);
    return () => window.removeEventListener("mivlet-builtin-plugins-changed", refresh);
  }, [queries]);
  useEffect(() => {
    active.current = scope;
    return () => {
      scope.epoch++; scope.preview++;
      if (active.current === scope) active.current = null;
      if (executionOwner && scope.target && scope.node?.control.status === "active") {
        void cancelRuntimeLocalComputer({ ...scope.target, expectedGeneration: scope.node.generation }).catch(() => undefined);
      }
    };
  }, [scope, executionOwner]);
  const files = useQuery({ queryKey: filesKey, enabled: false, retry: false, gcTime: 0, queryFn: async () => {
    const epoch = scope.epoch;
    const result = scope.target ? await listRuntimeLocalComputerFiles(scope.target) : null;
    return current(epoch) && result?.computerId === scope.node?.computerId ? result : null;
  } });
  const preview = useMutation({ mutationFn: async (input: { scope: typeof scope; epoch: number; request: number; path: string }) => {
    if (!input.scope.target) throw new Error("Choose an agent before opening files.");
    const result = await previewRuntimeLocalComputerFile({ ...input.scope.target, path: input.path });
    return input.scope === scope && current(input.epoch) && input.request === scope.preview ? result : null;
  } });
  const refresh = async () => {
    const epoch = scope.epoch;
    const disconnected = scope.disconnected;
    const result = await read();
    if (current(epoch)) {
      queries.setQueryData(queryKey, result);
      // The recovered data can be structurally equal to the pre-failure cache.
      // Still clear the displayed failure when React Query preserves that data.
      if (disconnected) redraw(value => value + 1);
    }
    return result;
  };
  const stop = async () => {
    scope.epoch++; scope.preview++;
    if (scope.node) {
      scope.node = { ...scope.node, controller: "paused", control: { ...scope.node.control, status: "idle", requestId: null, message: "Stopping computer input…" } };
      queries.setQueryData(queryKey, scope.node);
    }
    await stopRuntimeAppControl();
    const result = await refresh();
    if (active.current === scope) redraw(v => v + 1);
    return result;
  };
  const node = scope.disconnected ? null : computer.data ?? null;
  const previewCurrent = preview.variables?.scope === scope && preview.variables.epoch === scope.epoch && preview.variables.request === scope.preview;
  const error = computer.error;
  return {
    scopeKey: scope.key, available: Boolean(scope.target), node, controller: node?.controller ?? "paused", paused: node?.controller !== "agent",
    loading: computer.isLoading, busy: node?.control.status === "connecting", error: scope.failure ?? (error instanceof Error ? error.message : node?.message ?? null),
    stop, refresh,
    files: files.data ?? null, filesLoading: files.isFetching, filesError: files.error instanceof Error ? files.error.message : null,
    refreshFiles: () => files.refetch({ throwOnError: true }).then(r => r.data ?? null),
    filePreview: previewCurrent ? preview.data ?? null : null, filePreviewLoading: previewCurrent && preview.isPending,
    filePreviewError: previewCurrent && preview.error instanceof Error ? preview.error.message : null,
    previewFile: (path: string) => { preview.reset(); return preview.mutateAsync({ scope, epoch: scope.epoch, request: ++scope.preview, path }); },
    closeFilePreview: () => { scope.preview++; preview.reset(); redraw(v => v + 1); },
    prepareForTool: async (tool: string) => {
      const epoch = scope.epoch;
      const node = await refresh();
      if (!current(epoch) || scope.disconnected) throw new Error("Computer status changed. Refresh it before trying again.");
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
