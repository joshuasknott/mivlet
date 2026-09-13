import { PluginOverview } from "./PluginOverview";
import { useEffect, useRef, useState } from "react";
import type { ConnectorManifest } from "@fable/protocol";
import { openConnectorTools } from "../../lib/connector-mcp";
import { connectRemoteConnector } from "../../lib/connect-remote-connector";
import { connectorConnectionsChanged, remoteConnectionReady } from "../../lib/connector-connections";
import { connectorErrorMessage } from "../../lib/connector-errors";
import { disconnectRuntimeRemoteMcpAuthorization, listRuntimeMcpServerConfigurations, type RuntimeMcpConnectionDetails } from "../../runtime";
import { MarketplaceIcon } from "./MarketplaceIcon";
import type { MarketplaceConnectorEntry } from "./marketplace-catalog";
import { remoteConnectorServerId, type RemoteConnector } from "./remote-connectors";

export function RemoteConnectorDetails({ entry, preset, workspaceId, titleId, onSaved, onUseConnector }: {
  entry: MarketplaceConnectorEntry;
  preset: RemoteConnector;
  workspaceId?: string;
  titleId: string;
  onSaved: () => void;
  onUseConnector?: (connector: ConnectorManifest, prompt?: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const [discovery, setDiscovery] = useState<RuntimeMcpConnectionDetails | null>(null);

  const mounted = useRef(false);
  const operation = useRef(false);
  const serverId = remoteConnectorServerId(entry.id);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (!workspaceId) {
      setNotice("Open your workspace in the desktop app to connect this account.");
      setBusy(false);
    } else {
      void listRuntimeMcpServerConfigurations(workspaceId).then(async (servers) => {
        if (cancelled) return;
        setAvailable(servers !== null);
        const exists = Boolean(servers?.some((server) => server.id === serverId && !server.disabled));
        setSaved(exists);
        if (servers === null) setNotice("Account connections require the desktop app.");
        if (!exists) return;
        const connection = await openConnectorTools(workspaceId, serverId);
        try { if (!cancelled) setDiscovery(connection.discovery); }
        finally { await connection.client.close().catch(() => undefined); }
      }).catch((error) => {
        if (!cancelled) { setNotice(connectorErrorMessage(error)); setFailed(true); }
      }).finally(() => { if (!cancelled) setBusy(false); });
    }
    return () => { cancelled = true; mounted.current = false; };
  }, [workspaceId, serverId]);

  const run = async (task: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true); setNotice(""); setFailed(false);
    try { await task(); }
    catch (error) { if (mounted.current) { setNotice(connectorErrorMessage(error)); setFailed(true); } }
    finally {
      operation.current = false;
      if (workspaceId) connectorConnectionsChanged(workspaceId);
      if (mounted.current) { setBusy(false); onSaved(); }
    }
  };

  const connected = Boolean(discovery && remoteConnectionReady(discovery));
  const disabled = busy || !available;
  const status = busy ? "Connecting…" : connected ? "Connected" : failed || saved ? "Needs attention" : "Available";
  return <article className="connector-detail" aria-label={`${entry.name} connection`} aria-busy={busy}>
    <p className="connector-detail__eyebrow">Plugins</p>
    <div className="connector-detail__header">
      <span className={`marketplace-connector-icon marketplace-connector-icon--${entry.icon}`}><MarketplaceIcon id={entry.id} icon={entry.icon} /></span>
      <div><h2 id={titleId}>{entry.name}</h2><p>{entry.description}</p></div>
      <span className={`connector-detail__status${connected ? " connector-detail__status--connected" : ""}`}>{status}</span>
    </div>
    <p className="connector-detail__intro">{connected ? "Connected. The tools this server returned are available to your agents; changes still follow your workspace approval preference." : `Sign in to use ${entry.name} in your conversations.`}</p>
    <div className="connector-detail__actions">
      {connected && onUseConnector ? <button type="button" disabled={disabled} onClick={() => onUseConnector({ id: entry.id, name: entry.name, status: "connected", connectionRoute: "remote", permissions: [], healthSummary: "Connected", lastCheckedAt: discovery?.discoveredAt ?? "" })}>Use in chat</button> : null}
      {!connected ? <button type="button" disabled={disabled} onClick={() => void run(async () => {
        if (!workspaceId) return;
        setDiscovery(null);
        const result = await connectRemoteConnector(workspaceId, preset);
        if (mounted.current) { setSaved(true); setDiscovery(result); }
      })}>{busy ? "Connecting…" : saved ? "Reconnect" : "Connect"}</button> : null}
      {connected ? <button type="button" disabled={disabled} onClick={() => void run(async () => {
        if (!workspaceId) return;
        if (!await disconnectRuntimeRemoteMcpAuthorization(workspaceId, serverId)) throw new Error("Could not disconnect. Try again.");
        if (mounted.current) { setDiscovery(null); setNotice("Disconnected."); }
      })}>Disconnect</button> : null}
    </div>
    {notice ? <p className="connector-detail__notice" role={failed ? "alert" : "status"}>{notice}</p> : null}
    {!connected && preset.prerequisite ? <p className="connector-detail__notice">{preset.prerequisite}</p> : null}
    <PluginOverview id={entry.id} access={connected ? "Uses your connected account permissions" : "Chosen when you connect"} onExample={connected && !disabled && onUseConnector ? (prompt) => onUseConnector({ id: entry.id, name: entry.name, status: "connected", connectionRoute: "remote", permissions: [], healthSummary: "Connected", lastCheckedAt: discovery?.discoveredAt ?? "" }, prompt) : undefined} />
    <p className="connector-detail__hint">Read access is included when you connect; Mivlet only advertises tools the server discovered and enabled. Actions follow your workspace approval preference.</p>
    <details className="connector-guide"><summary>About this connection</summary>
      <p>Account access is managed by {entry.name}. You can disconnect at any time.</p>
      {preset.prerequisite ? <p>{preset.prerequisite}</p> : null}
      <a href={preset.documentation} target="_blank" rel="noreferrer">Connection help</a>
    </details>
  </article>;
}
