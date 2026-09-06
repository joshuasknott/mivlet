import { useEffect, useRef, useState } from "react";
import type { ApprovalResolutionRequest } from "@fable/protocol";
import { openConnectorTools } from "../../lib/connector-mcp";
import {
  beginRuntimeRemoteMcpAuthorization, commitRuntimeMcpServerConfiguration,
  disconnectRuntimeRemoteMcpAuthorization, listRuntimeMcpServerConfigurations,
  prepareRuntimeMcpServerConfiguration, resolveRuntimeApprovalRequest, setRuntimeMcpEnablement,
  type RuntimeMcpConnectionDetails, type RuntimeMcpServerConfiguration,
} from "../../runtime";
import { MarketplaceIcon } from "./MarketplaceIcon";
import type { MarketplaceConnectorEntry } from "./marketplace-catalog";
import { remoteConnectorServerId, type RemoteConnector } from "./remote-connectors";

export function RemoteConnectorDetails({ entry, preset, workspaceId, titleId, onSaved }: {
  entry: MarketplaceConnectorEntry;
  preset: RemoteConnector;
  workspaceId?: string;
  titleId: string;
  onSaved: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [discovery, setDiscovery] = useState<RuntimeMcpConnectionDetails | null>(null);
  const [endpoint, setEndpoint] = useState(preset.endpoint);
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
        // Reopening checks existing access without starting OAuth or expanding it.
        const connection = await openConnectorTools(workspaceId, serverId);
        try {
          if (!cancelled) setDiscovery(connection.discovery);
        } finally { await connection.client.close().catch(() => undefined); }
      }).catch(() => {
        if (!cancelled) setNotice("Connect to finish setup or restore access.");
      }).finally(() => { if (!cancelled) setBusy(false); });
    }
    return () => { cancelled = true; mounted.current = false; };
  }, [workspaceId, serverId]);

  const run = async (task: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setNotice("");
    try { await task(); }
    catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "Connection failed. Try again.");
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const connect = () => run(async () => {
    if (!workspaceId) return;
    setDiscovery(null);
    if (!saved) {
      const configuration: RuntimeMcpServerConfiguration = {
        workspaceId, id: serverId, displayName: entry.name,
        transport: "streamable-http", endpoint,
      };
      const prepared = await prepareRuntimeMcpServerConfiguration(configuration);
      if (!prepared) throw new Error("Account connections require the desktop app.");
      if (!mounted.current) return;
      // Connect is consent to this fixed official endpoint. Keep the exact native
      // configuration receipt without asking for a second, typed confirmation.
      const resolution: ApprovalResolutionRequest = {
        request: prepared.approval, decision: "once", decidedAt: new Date().toISOString(),
        confirmationText: prepared.approval.confirmationPhrase,
      };
      await resolveRuntimeApprovalRequest(resolution);
      if (!mounted.current) return;
      const configured = await commitRuntimeMcpServerConfiguration(configuration, resolution);
      if (!configured) throw new Error("Account connections require the desktop app.");
      if (!mounted.current) return;
      setSaved(true);
      onSaved();
    }
    const authorization = await beginRuntimeRemoteMcpAuthorization(workspaceId, serverId);
    if (!authorization) throw new Error("Account connections require the desktop app.");
    if (!mounted.current) return;
    const connection = await openConnectorTools(workspaceId, serverId);
    try {
      if (!mounted.current) return;
      const current = connection.discovery;
      const updated = await setRuntimeMcpEnablement(workspaceId, current.connectionId,
        current.connectionRevision, connection.tools.map((tool) => tool.name),
        current.enabledResources, current.capabilityBindings);
      if (!updated) throw new Error("Could not finish connecting. Try again.");
      if (!mounted.current) return;
      setDiscovery(updated);
      onSaved();
      setNotice(updated.enabledTools.length ? `${entry.name} is ready to use in your conversations.` : "Signed in, but this account has no available tools. Check its permissions.");
    } finally { await connection.client.close().catch(() => undefined); }
  });

  const connected = Boolean(discovery?.enabledTools.length);
  const disabled = busy || !available;
  return <article className="connector-detail" aria-label={`${entry.name} connection`}>
    <div className="connector-detail__header">
      <span className={`marketplace-connector-icon marketplace-connector-icon--${entry.icon}`}><MarketplaceIcon id={entry.id} icon={entry.icon} /></span>
      <div><h2 id={titleId}>{entry.name}</h2><p>{entry.description}</p></div>
      <span className="connector-detail__status">{busy ? "Connecting…" : connected ? "Connected" : "Not connected"}</span>
    </div>
    <section className="connector-guide">
      <p>{connected ? `Ask any agent to use ${entry.name} in a conversation.` : `Connect ${entry.name} to use it with all your agents.`}</p>
      <p>Tools are available after sign-in. Fable asks before changes or actions it cannot verify as read-only.</p>
      {preset.prerequisite ? <p>{preset.prerequisite}</p> : null}
      {!saved && preset.regions ? <label className="remote-connector-region">Account data region
        <select disabled={disabled} value={endpoint} onChange={(event) => setEndpoint(event.target.value)}>{preset.regions.map((region) => <option key={region.endpoint} value={region.endpoint}>{region.name}</option>)}</select>
      </label> : null}
    </section>
    <div className="connector-detail__actions">
      {!connected ? <button type="button" disabled={disabled} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button> : null}
      {saved ? <button type="button" disabled={disabled} onClick={() => void run(async () => {
        if (!workspaceId) return;
        const disconnected = await disconnectRuntimeRemoteMcpAuthorization(workspaceId, serverId);
        if (!disconnected) throw new Error("Account connections require the desktop app.");
        setDiscovery(null);
        setNotice("Disconnected.");
        onSaved();
      })}>Disconnect</button> : null}
    </div>
    {notice ? <p role="status">{notice}</p> : null}
    <details className="connector-guide"><summary>Connection details</summary>
      <p>Account access is managed by {entry.name}. You can disconnect at any time.</p>
      <a href={preset.documentation} target="_blank" rel="noreferrer">Connection help</a>
    </details>
  </article>;
}
