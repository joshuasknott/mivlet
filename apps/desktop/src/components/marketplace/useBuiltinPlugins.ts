import { useCallback, useEffect, useRef, useState } from "react";
import type { BuiltinPlugins } from "@fable/protocol";
import { loadRuntimeBuiltinPlugins, setRuntimeBuiltinPlugin } from "../../runtime";
import { connectorErrorMessage } from "../../lib/connector-errors";

/**
 * Native enablement state for built-in plugins. Readiness, runtime availability
 * and permission remain native-owned; this hook never infers either from
 * enablement.
 */
export function useBuiltinPlugins(workspaceId?: string) {
  const [plugins, setPlugins] = useState<BuiltinPlugins | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const updating = useRef(false);

  const read = useCallback(() => {
    if (!workspaceId) return;
    const current = epoch.current;
    const sequence = ++readSequence.current;
    void loadRuntimeBuiltinPlugins(workspaceId).then((value) => {
      if (current !== epoch.current || sequence !== readSequence.current) return;
      setPlugins(value);
      setLoadError("");
    }).catch((error: unknown) => {
      if (current !== epoch.current || sequence !== readSequence.current) return;
      setLoadError(connectorErrorMessage(error));
    });
  }, [workspaceId]);

  useEffect(() => {
    epoch.current++;
    setPlugins(null);
    setBusy(false);
    setLoadError("");
    setNotice("");
    updating.current = false;
    read();
    const refresh = () => { if (!updating.current) read(); };
    window.addEventListener("focus", refresh);
    return () => { epoch.current++; window.removeEventListener("focus", refresh); };
  }, [read]);

  const setEnabled = async (plugin: "computer", enabled: boolean) => {
    if (!workspaceId || updating.current) return false;
    const current = epoch.current;
    updating.current = true;
    readSequence.current++;
    setBusy(true);
    setNotice("");
    try {
      const result = await setRuntimeBuiltinPlugin(workspaceId, plugin, enabled);
      if (current !== epoch.current) return false;
      setPlugins(result);
      window.dispatchEvent(new Event("fable-builtin-plugins-changed"));
      setNotice(enabled
        ? "Enabled. Fresh permission is still required before an agent can control an application."
        : "Disabled. Any active application control stopped immediately; enable it again for fresh permission.");
      return true;
    } catch (error) {
      if (current !== epoch.current) return false;
      setNotice(connectorErrorMessage(error));
      try {
        const refreshed = await loadRuntimeBuiltinPlugins(workspaceId);
        if (current === epoch.current) setPlugins(refreshed);
      } catch { if (current === epoch.current) setPlugins(null); }
      window.dispatchEvent(new Event("fable-builtin-plugins-changed"));
      return false;
    } finally {
      if (current === epoch.current) {
        updating.current = false;
        setBusy(false);
      }
    }
  };

  return { plugins, busy, loadError, notice, refresh: read, setEnabled };
}
