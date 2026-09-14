import { useState } from "react";
import type { MemoryRecord } from "@fable/protocol";
import type { SettingsRuntime } from "./settings-runtime";

/** Human label for a memory's owning scope. Never widens the stored scope. */
function memoryScopeLabel(record: MemoryRecord): string {
  const scope = record.scope;
  if (!scope || scope.level === "global") return "Account-wide";
  if (scope.level === "agent") return `Agent ${scope.agentId}`;
  if (scope.level === "project") return `Project ${scope.projectId}`;
  if (scope.level === "thread") return `Side Chat ${scope.threadId}`;
  return `Work ${scope.workId}`;
}

export function MemoryRecords({ runtime }: { runtime: SettingsRuntime }) {
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const records = (runtime.managedMemoryRecords ?? []).filter((record) => !record.forgottenAt);
  const changeState = async (recordId: string, forget: boolean) => {
    if (pending) return;
    setPending(true); setError("");
    try { if (forget) await runtime.forgetMemory(recordId); else await runtime.toggleMemoryRecordDisabled(recordId); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The memory could not be updated."); }
    finally { setPending(false); }
  };
  const save = async () => {
    if (!editing || pending) return;
    setPending(true);
    setError("");
    try {
      await runtime.correctMemory(editing.id, editing.title, editing.value, editing.updatedAt);
      setEditing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The memory could not be corrected.");
    } finally { setPending(false); }
  };
  return <section className="profile-section memory-records" aria-labelledby="saved-memory-title">
    <h3 id="saved-memory-title">Saved memories</h3>
    <p>Correcting or forgetting a memory also invalidates any derived conversation summary that used it.</p>
    {records.length === 0 ? <p>No saved memories yet.</p> : records.map((record) => <div className="profile-section" key={record.id}>
      {editing?.id === record.id ? <form className="memory-settings-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="settings-field"><span>Title</span><input value={editing.title} maxLength={120} required disabled={pending} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label>
        <label className="settings-field"><span>Memory</span><textarea value={editing.value} maxLength={2000} required disabled={pending} rows={4} onChange={(event) => setEditing({ ...editing, value: event.target.value })} /></label>
        <div className="profile-action-row">
          <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save correction"}</button>
          <button className="button button--secondary" type="button" disabled={pending} onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
        </div>
      </form> : <>
        <strong>{record.title}</strong>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{record.value}</p>
        <small>{record.kind} · {memoryScopeLabel(record)} · {record.source}{record.disabled ? " · Disabled" : ""}</small>
        <div className="profile-action-row">
          <button className="button button--secondary" type="button" disabled={pending} onClick={() => { setEditing({ ...record }); setError(""); }}>Correct</button>
          <button className="button button--secondary" type="button" disabled={pending} onClick={() => { void changeState(record.id, false); }}>{record.disabled ? "Enable" : "Disable"}</button>
          <button className="button button--secondary" type="button" disabled={pending} onClick={() => { void changeState(record.id, true); }}>Forget</button>
        </div>
      </>}
    </div>)}
    {error ? <p role="alert">{error}</p> : <p role="status">{runtime.memoryStatus}</p>}
  </section>;
}
