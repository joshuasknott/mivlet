import { useEffect, useRef, useState } from "react";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import type { McpAppApprovalPreview } from "../../lib/mcp-app-host";

/** App requests belong to the conversation, even after its provider session
 * has completed. Closing, switching or starting work revokes pending requests. */
export function useMcpAppApprovals(runtime: ShellRuntime, identity: string, enabled: boolean) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const current = useRef({ identity, enabled });
  current.current = { identity, enabled };
  useEffect(() => () => {
    const owned = [...pending.current];
    pending.current.clear();
    if (owned.length) runtimeRef.current.clearBackendToolApprovals(owned);
    setIds(new Set());
  }, [identity, enabled]);
  const request = async (preview: McpAppApprovalPreview) => {
    if (!current.current.enabled) return null;
    const scope = current.current.identity;
    // Pane identity is workspace:conversation:generation. Keep this check at
    // the approval boundary so a stale app cannot enqueue into a newly
    // selected conversation during a React unmount race.
    const expected = `${preview.owner.workspaceId}:${preview.owner.conversationId}:${preview.owner.generation}`;
    // Require the complete workspace fence. A conversation and generation can
    // be reused after an account/workspace switch; suffix matching would let a
    // stale guest enqueue an approval into the newly active workspace.
    if (scope !== expected)
      return null;
    const id = preview.request.id;
    if (pending.current.has(id)) return null;
    const abortSignal = preview.abortSignal;
    if (abortSignal?.aborted) return null;
    pending.current.add(id);
    setIds(new Set(pending.current));
    const clearOnAbort = () => runtimeRef.current.clearBackendToolApprovals([id]);
    abortSignal?.addEventListener("abort", clearOnAbort, { once: true });
    try {
      // The abort signal is a renderer lifecycle fence. Strip it before the
      // shared runtime boundary so it can never enter native approval state.
      const { abortSignal: _abortSignal, ...nativePreview } = preview;
      const result = await runtimeRef.current.requestMcpAppApproval(nativePreview);
      return !abortSignal?.aborted && current.current.enabled && current.current.identity === scope
        ? result
        : null;
    } finally {
      abortSignal?.removeEventListener("abort", clearOnAbort);
      pending.current.delete(id);
      setIds(new Set(pending.current));
    }
  };
  return { ids, request };
}
