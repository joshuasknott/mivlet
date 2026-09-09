import { useEffect, useRef, useState } from "react";
import type { BuiltinPlugins as PluginState } from "@fable/protocol";
import { loadRuntimeBuiltinPlugins, setRuntimeBuiltinPlugin } from "../../runtime";
import { connectorErrorMessage } from "../../lib/connector-errors";
import { builtinPluginEntries as entries } from "../../lib/builtin-plugins";

export function BuiltinPlugins({ workspaceId, query, onUse }: { workspaceId?: string; query: string; onUse?: (id: "browser" | "computer") => void }) {
  const [plugins, setPlugins] = useState<PluginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const updating = useRef(false);
  useEffect(() => {
    const current = ++epoch.current;
    setPlugins(null);
    setNotice("");
    setBusy(false);
    updating.current = false;
    const refresh = () => {
      if (updating.current) return;
      const read = ++readSequence.current;
      if (workspaceId) void loadRuntimeBuiltinPlugins(workspaceId).then((value) => {
        if (current === epoch.current && read === readSequence.current) setPlugins(value);
      }).catch((error: unknown) => {
        if (current === epoch.current && read === readSequence.current) setNotice(connectorErrorMessage(error));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { epoch.current++; window.removeEventListener("focus", refresh); };
  }, [workspaceId]);
  const visible = entries.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase().trim()));
  if (!visible.length) return null;
  return <>
    <div className="marketplace-connector-grid">{visible.map((entry) => <div className="marketplace-connector-row marketplace-builtin" key={entry.id}>
      <span className="marketplace-connector-icon" aria-hidden="true"><img className="marketplace-builtin__icon" src={entry.icon} alt="" /></span>
      <span className="marketplace-connector-row__copy"><strong>{entry.name}</strong><span>{entry.description}</span><small>{!plugins ? "Unavailable" : plugins[entry.id] ? "Enabled · requires a running agent computer" : "Disabled"}</small></span>
      <div className="marketplace-builtin__actions">
      {onUse && plugins?.[entry.id] ? <button className="marketplace-builtin__toggle" type="button" disabled={busy} aria-label={`Use ${entry.name}`} onClick={() => onUse(entry.id)}>Use</button> : null}
      <button className="marketplace-builtin__toggle" type="button" aria-label={`${plugins?.[entry.id] ? "Disable" : "Enable"} ${entry.name}`} disabled={!plugins || busy} onClick={async () => {
        if (!workspaceId || !plugins || updating.current) return;
        const current = epoch.current;
        updating.current = true;
        readSequence.current++;
        setBusy(true); setNotice("");
        try {
          const result = await setRuntimeBuiltinPlugin(workspaceId, entry.id, !plugins[entry.id]);
          if (current === epoch.current) {
            setPlugins(result);
            window.dispatchEvent(new Event("fable-builtin-plugins-changed"));
            setNotice(result?.[entry.id] ? "Ask your agent to use it. A new computer starts when needed; paused work needs explicit returned control." : "Disabled. Computer work is paused; explicitly return control when you are ready.");
          }
        } catch (error) {
          if (current === epoch.current) {
            setNotice(connectorErrorMessage(error));
            try {
              const refreshed = await loadRuntimeBuiltinPlugins(workspaceId);
              if (current === epoch.current) setPlugins(refreshed);
            } catch { if (current === epoch.current) setPlugins(null); }
            window.dispatchEvent(new Event("fable-builtin-plugins-changed"));
          }
        } finally { if (current === epoch.current) { updating.current = false; setBusy(false); } }
      }}>{plugins?.[entry.id] ? "Disable" : "Enable"}</button>
      </div>
    </div>)}</div>
    {!plugins && !notice ? <p className="marketplace-section__empty">Open the desktop app to manage these Plugins.</p> : null}
    {notice ? <p role="status" className="marketplace-section__empty">{notice}</p> : null}
  </>;
}
