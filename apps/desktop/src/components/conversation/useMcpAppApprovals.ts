import { useEffect, useRef, useState } from "react";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import type { McpAppApprovalPreview } from "../../lib/mcp-app-host";

/** App requests belong to the conversation, even after its provider session
 * has completed. Closing, switching or starting work revokes pending requests. */
export function useMcpAppApprovals(runtime: ShellRuntime, identity: string, enabled: boolean) {
  const [owners, setOwners] = useState<ReadonlyMap<string, McpAppApprovalPreview["owner"]>>(new Map());
  const pendingOwners = useRef(new Map<string, McpAppApprovalPreview["owner"]>());
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const current = useRef({ identity, enabled });
  current.current = { identity, enabled };
  useEffect(() => () => {
    const owned = [...pendingOwners.current.keys()];
    pendingOwners.current.clear();
    if (owned.length) runtimeRef.current.clearBackendToolApprovals(owned);
    setOwners(new Map());
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
    if (pendingOwners.current.has(id)) return null;
    const abortSignal = preview.abortSignal;
    if (abortSignal?.aborted) return null;
    pendingOwners.current.set(id, preview.owner);
    setOwners(new Map(pendingOwners.current));
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
      pendingOwners.current.delete(id);
      setOwners(new Map(pendingOwners.current));
    }
  };
  return { ids: new Set(owners.keys()), owners, request };
}
