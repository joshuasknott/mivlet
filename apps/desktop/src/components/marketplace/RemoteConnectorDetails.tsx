import type { ConnectorManifest } from "@fable/protocol";
import { useEffect, useState } from "react";
import { connectRemoteConnector } from "../../lib/connect-remote-connector";
import {
  connectorConnectionsChanged,
  remoteConnectionReady,
} from "../../lib/connector-connections";
import { connectorErrorMessage } from "../../lib/connector-errors";
import { openConnectorTools } from "../../lib/connector-mcp";
import {
  disconnectRuntimeRemoteMcpAuthorization,
  listRuntimeMcpServerConfigurations,
  type RuntimeMcpConnectionDetails,
} from "../../runtime/domains/mcp";
import { MarketplaceIcon } from "./MarketplaceIcon";
import { PluginDetailHeader } from "./PluginDetailHeader";
import { PluginOverview } from "./PluginOverview";
import type { MarketplaceConnectorEntry } from "./marketplace-catalog";
import {
  remoteConnectorServerId,
  type RemoteConnector,
} from "./remote-connectors";
import { useConnectorOperation } from "./useConnectorOperation";

export function RemoteConnectorDetails({ entry, preset, workspaceId, titleId, onUseConnector }: {
  entry: MarketplaceConnectorEntry;
  preset: RemoteConnector;
  workspaceId?: string;
  titleId: string;
  onUseConnector?: (connector: ConnectorManifest, prompt?: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  const [available, setAvailable] = useState(false);
  const { busy, notice, failed, setBusy, setFailed, setNotice, run } = useConnectorOperation(true, () => {
    if (workspaceId) connectorConnectionsChanged(workspaceId);
  });
  const [discovery, setDiscovery] = useState<RuntimeMcpConnectionDetails | null>(null);

  const serverId = remoteConnectorServerId(entry.id);

  useEffect(() => {
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
    return () => { cancelled = true; };
  }, [workspaceId, serverId]);


  const connected = Boolean(discovery && remoteConnectionReady(discovery));
  const disabled = busy || !available;
  return <article className="connector-detail" aria-label={`${entry.name} connection`} aria-busy={busy}>
    <PluginDetailHeader name={entry.name} description={entry.description} icon={<span className={`marketplace-connector-icon marketplace-connector-icon--${entry.icon}`}><MarketplaceIcon id={entry.id} icon={entry.icon} /></span>} titleId={titleId} status={busy ? "Connecting…" : connected ? "Connected" : failed || saved ? "Needs attention" : "Available"} />
    <p className="connector-detail__intro">{connected ? "Ready to use with any of your agents." : `Sign in to use ${entry.name} in your conversations.`}</p>
    <div className="connector-detail__actions">
      {connected && onUseConnector ? <button type="button" disabled={disabled} onClick={() => onUseConnector({ id: entry.id, name: entry.name, status: "connected", connectionRoute: "remote", permissions: [], healthSummary: "Connected", lastCheckedAt: discovery?.discoveredAt ?? "" })}>Use in chat</button> : null}
      {!connected ? <button type="button" disabled={disabled} onClick={() => void run(async (isCurrent) => {
        if (!workspaceId) return;
        setDiscovery(null);
        const result = await connectRemoteConnector(workspaceId, preset);
        if (isCurrent()) { setSaved(true); setDiscovery(result); }
      })}>{busy ? "Connecting…" : saved ? "Reconnect" : "Connect"}</button> : null}
      {connected ? <button type="button" disabled={disabled} onClick={() => void run(async (isCurrent) => {
        if (!workspaceId) return;
        if (!await disconnectRuntimeRemoteMcpAuthorization(workspaceId, serverId)) throw new Error("Could not disconnect. Try again.");
        if (isCurrent()) { setDiscovery(null); setNotice("Disconnected."); }
      })}>Disconnect</button> : null}
    </div>
    {notice ? <p className="connector-detail__notice" role={failed ? "alert" : "status"}>{notice}</p> : null}
    {!connected && preset.prerequisite ? <p className="connector-detail__notice">{preset.prerequisite}</p> : null}
    <PluginOverview id={entry.id} access={connected ? "Uses your connected account permissions" : "Chosen when you connect"} onExample={connected && !disabled && onUseConnector ? (prompt) => onUseConnector({ id: entry.id, name: entry.name, status: "connected", connectionRoute: "remote", permissions: [], healthSummary: "Connected", lastCheckedAt: discovery?.discoveredAt ?? "" }, prompt) : undefined} />
    <p className="connector-detail__hint">The tools this connection provides become available to your agents; consequential actions still follow your workspace approval preference.</p>
    <details className="connector-guide"><summary>About this connection</summary>
      <p>Account access is managed by {entry.name}. You can disconnect at any time.</p>
      {preset.prerequisite ? <p>{preset.prerequisite}</p> : null}
      <a href={preset.documentation} target="_blank" rel="noreferrer">Connection help</a>
    </details>
  </article>;
}
