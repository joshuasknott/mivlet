import type { TokenPluginDefinition } from "@fable/connectors/providers/token-plugins";
import type {
  ConnectorAccountOption,
  ConnectorManifest,
} from "@fable/protocol";
import { useRef, useState } from "react";
import { connectorConnectionsChanged } from "../../lib/connector-connections";
import { connectRuntimeTokenPlugin } from "../../runtime/domains/connectors";
import { MarketplaceIcon } from "./MarketplaceIcon";
import { PluginDetailHeader } from "./PluginDetailHeader";
import { marketplaceConnectorSections } from "./marketplace-catalog";
import { useConnectorOperation } from "./useConnectorOperation";

export function TokenPluginDetails({ plugin, connector, workspaceId, onUseConnector, onDisconnect, titleId, accounts = [], onSwitchAccount }: {
  plugin: TokenPluginDefinition; connector?: ConnectorManifest | null; workspaceId?: string;
  onUseConnector: (connector: ConnectorManifest, prompt?: string) => void;
  onDisconnect: (id: string) => void | Promise<void>; titleId: string;
  accounts?: ConnectorAccountOption[]; onSwitchAccount?: (id: string, connectionId: string) => void;
}) {
  const [override, setOverride] = useState<{ source: ConnectorManifest | null | undefined; result: ConnectorManifest } | null>(null);
  const { busy, notice, setNotice, run } = useConnectorOperation();
  const tokenRef = useRef<HTMLInputElement>(null);
  const fieldsRef = useRef<Record<string, HTMLInputElement | null>>({});
  const current = override && override.source === connector ? override.result : connector;
  const ready = current?.status === "connected" && current.health?.state === "healthy";
  const icon = marketplaceConnectorSections.flatMap((section) => section.connectors).find((entry) => entry.id === plugin.id)?.icon ?? "product";
  const connect = async (isCurrent: () => boolean) => {
    if (!workspaceId) throw new Error("Select a workspace before connecting.");
    const credential = { token: tokenRef.current?.value.trim() ?? "", ...Object.fromEntries((plugin.fields ?? []).map((field) => [field.name, fieldsRef.current[field.name]?.value.trim() ?? ""])) };
    if (tokenRef.current) tokenRef.current.value = "";
    for (const field of plugin.fields ?? []) if (field.secret && fieldsRef.current[field.name]) fieldsRef.current[field.name]!.value = "";
    try {
      const result = await connectRuntimeTokenPlugin(workspaceId, plugin.id, credential);
      if (isCurrent()) setOverride({ source: connector, result });
      connectorConnectionsChanged(workspaceId);
      if (isCurrent() && result.health?.state !== "healthy") setNotice(result.healthSummary);
    } finally { credential.token = ""; if ("developerToken" in credential) credential.developerToken = ""; }
  };
  return <article className="connector-detail" aria-label={`${plugin.name} details`} aria-busy={busy}>
    <PluginDetailHeader name={plugin.name} description={plugin.description} icon={<span className={`marketplace-connector-icon marketplace-connector-icon--${icon}`}><MarketplaceIcon id={plugin.id} icon={icon} /></span>} titleId={titleId} status={busy ? "Checking access…" : ready ? "Connected" : current ? "Needs attention" : "Available"} />
    {ready ? <>
      {accounts.length > 1 && onSwitchAccount ? <label className="connector-detail__account">Account<select aria-label="Active connection" disabled={busy} value={accounts.find((a) => a.active)?.connectionId ?? ""} onChange={(event) => onSwitchAccount(plugin.id, event.target.value)}>{accounts.map((a) => <option key={a.connectionId} value={a.connectionId}>{a.account.displayName}</option>)}</select></label> : null}
      <p className="connector-detail__intro">Read access is ready. This connection supports only the reads listed below; writes, publishing, knowledge sync and token renewal are not available.</p>
      <div className="connector-detail__actions">
        <button type="button" disabled={busy} onClick={() => onUseConnector(current!)}>Use in chat</button>
        <button type="button" disabled={busy} onClick={() => void run(async (isCurrent) => { await onDisconnect(plugin.id); if (isCurrent()) setOverride({ source: connector, result: { ...current!, status: "revoked", account: undefined } }); if (workspaceId) connectorConnectionsChanged(workspaceId); })}>Disconnect</button>
      </div>
    </> : <form className="token-plugin-form" onSubmit={(event) => { event.preventDefault(); void run(connect); }}>
      <p>{plugin.setup}</p>
      <label>Access token or API key<input ref={tokenRef} type="password" autoComplete="off" spellCheck={false} required disabled={busy} maxLength={16384} /></label>
      {plugin.fields?.map((field) => <label key={field.name}>{field.label}<input ref={(element) => { fieldsRef.current[field.name] = element; }} type={field.secret ? "password" : "text"} autoComplete="off" spellCheck={false} required={!field.optional} disabled={busy} placeholder={field.placeholder} maxLength={2048} /></label>)}
      <p className="connector-detail__hint">Stored in this device's secure credential store. Provider-issued access tokens may expire; reconnect with a fresh token when needed.</p>
      {!workspaceId ? <p className="connector-detail__hint">Open a workspace in the desktop app to connect this account.</p> : null}
      <div className="connector-detail__actions"><button type="submit" disabled={busy || !workspaceId}>{busy ? "Checking access…" : "Verify and connect"}</button></div>
    </form>}
    {notice ? <p role="alert" className="connector-detail__notice">{notice}</p> : null}
    <div className="plugin-overview"><section className="plugin-overview__about"><h3>Available reads</h3><ul>{Object.values(plugin.capabilities).map((help) => <li key={help}>{help}</li>)}</ul></section></div>
    <details className="connector-guide"><summary>Setup and permissions</summary><p>{plugin.setup}</p><a href={plugin.docs} target="_blank" rel="noreferrer">Official API documentation</a><p>This connection currently supports the reads shown above. Token renewal, publishing and other changes are not supported.</p></details>
  </article>;
}
