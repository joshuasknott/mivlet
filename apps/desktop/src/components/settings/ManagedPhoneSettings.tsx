import { useEffect, useRef, useState } from "react";
import { DeviceMobile } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import type { PhoneRelayConnectRequest, PhoneRelayDisconnectRequest, PhoneRelayStatus } from "@mivlet/protocol";
import { connectPhoneRelay, disconnectPhoneRelay, getPhoneRelayStatus } from "../../runtime/domains/phone-relay";
import { getActiveRuntimeDataScope } from "../../runtime-scope";

export interface ManagedPhoneApi {
  status: () => Promise<PhoneRelayStatus>;
  connect: (request: PhoneRelayConnectRequest) => Promise<PhoneRelayStatus>;
  disconnect: (request: PhoneRelayDisconnectRequest) => Promise<PhoneRelayStatus>;
}
const nativeApi: ManagedPhoneApi = { status: getPhoneRelayStatus, connect: connectPhoneRelay, disconnect: disconnectPhoneRelay };

async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Mivlet did not respond. Check phone status before trying again.")), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Native owns the relay address, selected device, and browser grants. */
export function ManagedPhoneSettings({ workspaceId, api = nativeApi }: { workspaceId: string; api?: ManagedPhoneApi }) {
  const scope = getActiveRuntimeDataScope();
  const owner = useRef({ scope, workspaceId });
  owner.current = { scope, workspaceId };
  const mounted = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const uncertainRef = useRef(false);
  const [status, setStatus] = useState<PhoneRelayStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const current = () => mounted.current && scope !== null && scope.workspaceId === workspaceId
    && getActiveRuntimeDataScope() === scope && owner.current.scope === scope && owner.current.workspaceId === workspaceId;
  const accept = (next: PhoneRelayStatus) => {
    if (next.workspaceId !== workspaceId) throw new Error("Select this workspace in the signed-in desktop app before connecting your phone.");
    setStatus(next);
    setError("");
    uncertainRef.current = false;
    setUncertain(false);
  };
  const read = async () => {
    if (!current() || pending.current) return;
    const request = ++sequence.current;
    try {
      const next = await bounded(api.status());
      if (current() && request === sequence.current) accept(next);
    } catch (reason) {
      if (current() && request === sequence.current) setError(reason instanceof Error ? reason.message : "Phone status is unavailable.");
    }
  };
  useEffect(() => {
    mounted.current = true;
    setStatus(null); setError(""); setNotice(""); setBusy(""); setUncertain(false);
    pending.current = false; uncertainRef.current = false;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || !current()) return;
      if (!uncertainRef.current) await read();
      if (active && current()) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { active = false; mounted.current = false; ++sequence.current; clearTimeout(timer); };
  }, [workspaceId, scope, api]);

  const change = async (name: string, action: () => Promise<PhoneRelayStatus>) => {
    if (!current() || pending.current || uncertainRef.current || error || status?.workspaceId !== workspaceId) return;
    pending.current = true;
    const request = ++sequence.current;
    setBusy(name); setNotice("");
    try {
      const next = await bounded(action());
      if (current() && request === sequence.current) accept(next);
    } catch (reason) {
      if (current() && request === sequence.current) {
        uncertainRef.current = true; setUncertain(true);
        setError(reason instanceof Error ? reason.message : "The phone connection outcome is unknown.");
      }
    } finally {
      if (current() && request === sequence.current) { pending.current = false; setBusy(""); }
    }
  };
  const owned = current() && status?.workspaceId === workspaceId;
  const connected = owned && status.state === "connected";
  const active = owned && (status.state === "connected" || status.state === "connecting");
  const connectScope = owned && status.cloudWorkspaceId && status.deviceId
    ? { workspaceId, cloudWorkspaceId: status.cloudWorkspaceId, deviceId: status.deviceId } : null;
  const exactConnection = owned && status.connectionId && status.epoch ? { connectionId: status.connectionId, epoch: status.epoch } : null;
  // The address is displayed as text only. Native controls its destination and credentials.
  const phoneUrl = connected && !error && !uncertain ? status.phoneUrl : undefined;
  const label = !current() ? "Unavailable" : error ? "Status unavailable" : !status ? "Checking" : status.state === "connected" ? "Connected" : status.state === "connecting" ? "Connecting" : status.state === "disconnected" ? "Disconnected" : "Not connected";

  return <section className="mcp-server-panel" aria-label="Connect your phone" aria-busy={Boolean(busy)}>
    <header className="mcp-panel-heading">
      <span className="mcp-panel-icon"><DeviceMobile size={24} aria-hidden="true" /></span>
      <div><div className="mcp-title-row"><h3>Your phone</h3><span className={`mcp-state${connected && !error ? " mcp-state--running" : ""}`}>{label}</span></div>
        <p className="mcp-description">Follow shared work and send permitted tasks from your phone.</p></div>
    </header>
    <p>Keep this computer awake with Mivlet open and signed in. Approve each phone here; tool approvals stay on this computer.</p>
    <p className="mcp-description">Cloudflare carries the requests, status and results you choose to share over an encrypted connection. The relay keeps temporary connection records, not task content. Provider keys stay on this computer.</p>
    <p className="mcp-description">This connection uses the selected workspace on this computer. Manual MCP access must be stopped before connecting.</p>
    {phoneUrl && <label>Phone link<input readOnly value={phoneUrl} onFocus={event => event.target.select()} /></label>}
    <div className="profile-action-row">
      {!active && <button type="button" className="button button--primary" disabled={!connectScope || Boolean(busy) || Boolean(error) || uncertain} onClick={() => { if (connectScope) void change("Connecting…", () => api.connect(connectScope)); }}>{busy === "Connecting…" ? busy : "Connect phone"}</button>}
      {phoneUrl && <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => {
        if (!current()) return;
        void navigator.clipboard.writeText(phoneUrl).then(() => { if (current()) setNotice("Phone link copied. Open it on your phone, then approve access here."); }, () => { if (current()) setNotice("Copy the phone link from the field above."); });
      }}><Copy size={18} aria-hidden="true" />Copy phone link</button>}
      {exactConnection && <button type="button" className="button button--secondary" disabled={Boolean(busy) || Boolean(error) || uncertain} onClick={() => void change("Disconnecting…", () => api.disconnect(exactConnection))}>{busy === "Disconnecting…" ? busy : "Disconnect phone"}</button>}
      <button type="button" className="button button--secondary" disabled={Boolean(busy) || !current()} onClick={() => { setNotice(""); void read(); }}>Check phone status</button>
    </div>
    {busy && <p role="status">{busy}</p>}
    {error && <p className="mcp-notice mcp-notice--error" role="alert">{error}{uncertain && " The request may have completed. Check phone status before another connection action; nothing will be retried automatically."}</p>}
    {!error && status?.error && owned && <p className="mcp-notice" role="status">{status.error}</p>}
    {!error && owned && !connectScope && !status.error && <p role="status">Connect this computer to the selected account workspace before connecting your phone.</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
