import type { LocalComputerSnapshot, LocalComputerTarget } from "@fable/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cancelRuntimeLocalComputer, listRuntimeLocalComputerFiles, loadRuntimeLocalComputer,
  previewRuntimeLocalComputerFile, stopRuntimeAppControl } from "../runtime";

/** Native permission never lives in this hook. Epochs discard late UI results. */
export function useLocalComputer({ workspaceId, agentId }: { workspaceId?: string; agentId: string }) {
  const queries = useQueryClient();
  const instance = useId();
  const scope = useMemo(() => ({ key: `${workspaceId}:${agentId}:${instance}`, target: workspaceId ? { workspaceId, agentId } as LocalComputerTarget : null,
    epoch: 0, request: 0, preview: 0, node: null as LocalComputerSnapshot | null, disconnected: false }), [workspaceId, agentId, instance]);
  const active = useRef<typeof scope | null>(scope); active.current = scope;
  const [, redraw] = useState(0);
  const queryKey = ["local-computer", scope.key] as const;
  const filesKey = ["local-computer-files", scope.key] as const;
  const current = (epoch = scope.epoch) => active.current === scope && scope.epoch === epoch;
  const accept = (node: LocalComputerSnapshot | null) => {
    if (!node || !scope.target) { scope.node = null; return null; }
    if (node.workspaceId !== workspaceId || node.agentId !== agentId || node.generation < (scope.node?.generation ?? 0)) return scope.node;
    if (node.generation !== scope.node?.generation) { scope.preview++; }
    scope.node = node; scope.disconnected = false; return node;
  };
  const read = async () => {
    if (!scope.target) return scope.node;
    const epoch = scope.epoch; const request = ++scope.request;
    try {
      const result = await loadRuntimeLocalComputer(scope.target);
      return current(epoch) && request === scope.request ? accept(result) : scope.node;
    } catch (error) {
      if (current(epoch)) { scope.disconnected = true; scope.epoch++; scope.preview++; }
      throw error;
    }
  };
  const computer = useQuery({ queryKey, queryFn: read, enabled: Boolean(scope.target), retry: false, gcTime: 0,
    // Preserve demand-based polling: no native image or process probes at idle.
    refetchInterval: query => query.state.data?.control.status === "active" || query.state.data?.control.status === "connecting" ? 2_000 : 30_000 });
  useEffect(() => {
    const refresh = () => { void queries.invalidateQueries({ queryKey: ["local-computer"] }); };
    window.addEventListener("fable-builtin-plugins-changed", refresh);
    return () => window.removeEventListener("fable-builtin-plugins-changed", refresh);
  }, [queries]);
  useEffect(() => {
    active.current = scope;
    return () => {
      scope.epoch++; scope.preview++;
      if (active.current === scope) active.current = null;
      if (scope.target && scope.node?.control.status === "active") {
        void cancelRuntimeLocalComputer({ ...scope.target, expectedGeneration: scope.node.generation }).catch(() => undefined);
      }
    };
  }, [scope]);
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
    const result = await read();
    if (current()) queries.setQueryData(queryKey, result);
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
    loading: computer.isLoading, busy: node?.control.status === "connecting", error: error instanceof Error ? error.message : node?.message ?? null,
    stop, refresh,
    files: files.data ?? null, filesLoading: files.isFetching, filesError: files.error instanceof Error ? files.error.message : null,
    refreshFiles: () => files.refetch({ throwOnError: true }).then(r => r.data ?? null),
    filePreview: previewCurrent ? preview.data ?? null : null, filePreviewLoading: previewCurrent && preview.isPending,
    filePreviewError: previewCurrent && preview.error instanceof Error ? preview.error.message : null,
    previewFile: (path: string) => { preview.reset(); return preview.mutateAsync({ scope, epoch: scope.epoch, request: ++scope.preview, path }); },
    closeFilePreview: () => { scope.preview++; preview.reset(); redraw(v => v + 1); },
    prepareForTool: async (tool: string) => {
      const node = await refresh();
      if (!node || !current() || scope.disconnected || !node.plugins?.computer) throw new Error("Enable Computer Use in Plugins first.");
      if (tool.startsWith("local-app-") || tool.startsWith("local-desktop-")) {
        if (!node.runtimeAvailable) throw new Error("The bundled Windows computer runtime is unavailable.");
      }
      return node;
    },
  };
}
