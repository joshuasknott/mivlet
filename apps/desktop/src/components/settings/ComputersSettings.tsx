import { useState } from "react";
import { Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { useCloudComputer } from "../../hooks/useCloudComputer";
import "./computers-settings.css";

export function ComputersSettings({ workspaceId, agentId, onOpenComputer }: {
  workspaceId: string;
  agentId?: string;
  onOpenComputer?: () => void;
}) {
  const { status, pending, error, refresh, act } = useCloudComputer(workspaceId);
  const [machineId, setMachineId] = useState("");
  const [name, setName] = useState("Mivlet computer");
  const machine = status?.connected ? status.machine : null;
  const quotaFull = status?.usage?.machineLimit != null && status.usage.machineCount != null &&
    status.usage.machineCount >= status.usage.machineLimit;
  const blocked = pending || Boolean(status?.pendingAction);
  const creationBlocked = blocked || quotaFull || Boolean(status?.error);
  return <div className="settings-stack computers-settings">
    <p className="settings-intro">Choose where your agents work.</p>
    <section className="settings-group__surface" aria-label="This PC">
      <div className="settings-preference-row">
        <Desktop size={24} aria-hidden="true" />
        <span className="computers-settings__identity"><strong>This PC</strong><small>Your Windows computer. Default for every agent.</small></span>
        <span>Default</span>
      </div>
    </section>
    <section className="settings-group__surface" aria-labelledby="instabox-heading">
      <div className="settings-preference-row">
        <Cloud size={24} aria-hidden="true" />
        <span className="computers-settings__identity"><strong id="instabox-heading">Instabox</strong>
          <small>{machine ? `${machine.name} · ${machine.status}` : status?.connected ? "Choose a computer from your account." : "Use your own account and machine."}</small>
        </span>
        {!status?.connected ? <button type="button" disabled={pending || !agentId || !status} onClick={() => agentId && void act({ kind: "connect", agentId })}>Connect Instabox</button> : null}
        {machine ? <div className="computers-settings__actions">
          {onOpenComputer ? <button type="button" disabled={blocked} onClick={onOpenComputer}>Open computer</button> : null}
          <button type="button" disabled={blocked || !["running", "suspended", "paused", "stopped"].includes(machine.status)} onClick={() => void act({ kind: machine.status === "running" ? "pause" : "resume", machineId: machine.id })}>{machine.status === "running" ? "Pause" : machine.status === "stopped" ? "Start" : "Resume"}</button>
          <button type="button" disabled={pending} onClick={() => void act({ kind: "disconnect" })}>Disconnect</button>
        </div> : null}
      </div>
      {!status?.connected ? <p className="computers-settings__note">Enter your API key in a protected Windows window. Checking it does not create a machine.</p> : <>
        <p className="computers-settings__note">Disconnect keeps your machine and files. Pause preserves remote processes.</p>
        {!machine ? <>
          <form className="computers-settings__form" onSubmit={event => { event.preventDefault(); if (!creationBlocked && name.trim()) void act({ kind: "create", name: name.trim() }); }}>
            <strong>Create a computer</strong>
            <label htmlFor="instabox-name">Machine name</label>
            <input id="instabox-name" required maxLength={80} value={name} disabled={creationBlocked} onChange={event => setName(event.target.value)} />
            <p>Creates and starts one Linux desktop under your Instabox plan and charges. No provider keys, workspace files or Vault secrets are copied.</p>
            {status.usage?.machineCount != null && status.usage.machineLimit != null ? <small>{status.usage.machineCount} of {status.usage.machineLimit} machine slots used.</small> : <small>Instabox checks your account allowance before creation.</small>}
            <button type="submit" disabled={creationBlocked || !name.trim()}>Create computer</button>
          </form>
          {quotaFull ? <p className="computers-settings__note">No free machine slots. Choose an existing machine or manage your Instabox allowance.</p> : null}
        </> : null}
        <details className="settings-disclosure">
          <summary>Use an existing machine</summary>
          <div className="computers-settings__form">
            {status.machines.length ? <>
              <label htmlFor="instabox-machine">Existing machine</label>
              <select id="instabox-machine" value={machineId} disabled={blocked} onChange={event => setMachineId(event.target.value)}>
                <option value="">Select a machine</option>
                {status.machines.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}
              </select>
              <button type="button" disabled={blocked || !machineId} onClick={() => void act({ kind: "select", machineId })}>Use this machine</button>
            </> : <p>No machines found in your account.</p>}
          </div>
        </details>
        <div className="computers-settings__actions">
          {agentId ? <button type="button" disabled={pending} onClick={() => void act({ kind: "connect", agentId })}>Replace API key</button> : null}
          {!machine ? <button type="button" disabled={pending} onClick={() => void act({ kind: "disconnect" })}>Disconnect</button> : null}
        </div>
        <p className="computers-settings__note">Agent computer actions are not available yet.</p>
        <details className="settings-disclosure"><summary>Cloud access and limits</summary>
          <p className="computers-settings__note">Agents share this computer. Commands, file transfer and desktop input are not available yet. Website sign-ins are separate.</p>
          <p className="computers-settings__note">Mivlet must stay open to run its agent loop. Closing it does not guarantee that remote processes stop.</p>
        </details>
      </>}
    </section>
    {status?.pendingAction ? <p role="status">This change is not confirmed yet. Check its result before retrying.</p> : null}
    {pending ? <p role="status">Checking your computer…</p> : null}
    {error || status?.error ? <p role="alert">{error || status?.error}</p> : null}
    <div className="computers-settings__actions"><button type="button" disabled={pending} onClick={() => void (status?.pendingAction ? act({ kind: "reconcile" }) : refresh())}>{status?.pendingAction ? "Check operation result" : "Refresh"}</button></div>
  </div>;
}
