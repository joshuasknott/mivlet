import { useEffect, useRef, useState } from "react";
import type { HostedProviderConnection, HostedProviderEnroll, HostedProviderRevoke, HostedProviderScope, HostedTextProviderId } from "@mivlet/protocol";
import { ProviderIcon } from "../ProviderIcon";
import { enrollHostedProvider, listHostedProviders, revokeHostedProvider } from "../../runtime/domains/hosted-tasks";
import { getActiveRuntimeDataScope } from "../../runtime-scope";
import { boundedHostedRead, hostedProviderLabels, hostedScopeKey } from "./hosted-ui";
import "./hosted-controls.css";

export interface HostedProviderApi {
  list: (scope: HostedProviderScope) => Promise<HostedProviderConnection[]>;
  enroll: (request: HostedProviderEnroll) => Promise<HostedProviderConnection>;
  revoke: (request: HostedProviderRevoke) => Promise<HostedProviderConnection>;
}
const defaultApi: HostedProviderApi = { list: listHostedProviders, enroll: enrollHostedProvider, revoke: revokeHostedProvider };
export interface HostedProviderSettingsProps {
  workspaceId: string;
  agents: readonly { id: string; name: string }[];
  api?: HostedProviderApi;
}

export function HostedProviderSettings(props: HostedProviderSettingsProps) {
  const [selected, setSelected] = useState("");
  const agentId = props.agents.some(agent => agent.id === selected) ? selected : props.agents[0]?.id;
  return <div className="hosted-provider-settings">
    <label>Cloud connection for agent<select aria-label="Cloud connection agent" value={agentId ?? ""} onChange={event => setSelected(event.target.value)}>{props.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    {agentId ? <ProviderSettings key={`${hostedScopeKey()}:${props.workspaceId}:${agentId}`} workspaceId={props.workspaceId} agentId={agentId} api={props.api} /> : <p>Add an agent before connecting a cloud provider.</p>}
  </div>;
}
function ProviderSettings({ workspaceId, agentId, api = defaultApi }: HostedProviderScope & { api?: HostedProviderApi }) {
  const scope = useRef(getActiveRuntimeDataScope()).current;
  const [connections, setConnections] = useState<HostedProviderConnection[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const live = useRef(true);
  const busy = useRef(false);
  const current = () => live.current && scope !== null && getActiveRuntimeDataScope() === scope && scope.workspaceId === workspaceId;
  const run = async (name: string, action: () => Promise<void>) => {
    if (busy.current || !current()) return;
    busy.current = true; setPending(name); setError("");
    try { await action(); }
    catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "The cloud connection is unavailable."); }
    finally { busy.current = false; if (current()) setPending(""); }
  };
  const load = async () => {
    const result = await boundedHostedRead(api.list({ workspaceId, agentId }));
    if (current()) { setConnections(result); setLoaded(true); }
  };
  useEffect(() => {
    live.current = true;
    void run("refresh", load);
    return () => { live.current = false; };
  }, []);
  return <section className="settings-group hosted-provider-settings" aria-label="Cloud task connections">
    <header className="hosted-card__heading"><h2>Cloud tasks</h2><span>Text tasks only</span></header>
    <p>Let an explicitly reviewed text task finish while your computer is asleep.</p>
    <p className="hosted-muted">Connect a separate API key for cloud use. Your local provider connections are never transferred. Cloud keys expire after 30 days; task text is retained for 24 hours. This uses a temporary development service.</p>
    <div className="hosted-provider-list">{(Object.keys(hostedProviderLabels) as HostedTextProviderId[]).flatMap(providerId => {
      const matching = current() ? connections.filter(value => value.providerId === providerId && value.enabled).sort((left, right) => right.updatedAt - left.updatedAt) : [];
      const rows: (HostedProviderConnection | undefined)[] = matching.length ? matching : [undefined];
      return rows.map((connection, index) => <div className="hosted-provider-row" key={`${providerId}:${connection?.credentialId ?? "new"}`}>
        <ProviderIcon provider={providerId} size={26} />
        <div><strong>{hostedProviderLabels[providerId]}{matching.length > 1 ? ` · connection ${index + 1}` : ""}</strong><small>{!loaded ? "Checking connection…" : connection ? `${connection.expiresAt > Date.now() ? "Connected" : "Expired"} · expires ${new Date(connection.expiresAt).toLocaleDateString()}` : "Not connected"}</small></div>
        <div className="hosted-actions">
          <button type="button" className={connection ? "button button--secondary" : "button button--primary"} disabled={Boolean(pending) || !loaded || !current()} onClick={() => void run(providerId, async () => {
            await api.enroll({ workspaceId, agentId, providerId, ...(connection ? { credentialId: connection.credentialId, expectedRevision: connection.revision } : {}) });
            if (current()) await load();
          })}>{pending === providerId ? "Opening secure entry…" : connection ? "Replace key" : "Connect hosted API key"}</button>
          {connection && <button type="button" className="button button--secondary" disabled={Boolean(pending)} onClick={() => void run(`revoke:${providerId}`, async () => {
            await boundedHostedRead(api.revoke({ workspaceId, agentId, credentialId: connection.credentialId, revision: connection.revision }));
            if (current()) await load();
          })}>Disconnect</button>}
        </div>
      </div>);
    })}</div>
    <p className="hosted-muted">Enter the key in the secure native window. It is stored in your cloud connection, separately from this device’s credentials. Provider usage is billed by your provider.</p>
    <button type="button" className="button button--secondary" disabled={Boolean(pending)} onClick={() => void run("refresh", load)}>Refresh connections</button>
    {pending === "refresh" && <p role="status">Checking cloud connections…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
