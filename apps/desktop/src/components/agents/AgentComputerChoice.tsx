import type { AgentComputerPreference } from "@mivlet/protocol";
import { useCloudComputer } from "../../hooks/useCloudComputer";

export function AgentComputerChoice({ workspaceId, value, invalid, onChange }: {
  workspaceId?: string;
  value?: AgentComputerPreference;
  invalid?: boolean;
  onChange: (value: AgentComputerPreference) => void;
}) {
  const { status, pending } = useCloudComputer(workspaceId);
  const machine = status?.connected && !status.error ? status.machine : null;
  const cloud = value?.kind === "instabox";
  return <label className="agent-editor__field">
    <span>Computer</span>
    <select aria-label="Computer" aria-invalid={invalid || undefined} value={invalid ? "invalid" : cloud ? "instabox" : "local"} onChange={event => {
      if (event.target.value === "local") onChange({ kind: "local" });
      else if (machine && status) onChange({ kind: "instabox", machineId: machine.id, connectionRevision: status.connectionRevision });
    }}>
      {invalid ? <option value="invalid" disabled>Computer unavailable · choose again</option> : null}
      <option value="local">This PC</option>
      <option value="instabox" disabled={!machine || pending}>Cloud · Instabox{cloud && !machine ? " · reconnect in Settings" : ""}</option>
    </select>
    <small>Applies to new work. Current work keeps its computer.</small>
    {invalid ? <small role="alert">The saved computer choice is invalid. Choose a computer explicitly before new work.</small> : null}
    {cloud ? <small>Agent computer actions are unavailable until a restricted cloud runtime is verified. No actions fall back to This PC.</small> : !machine ? <small>Connect your own machine in Settings → Computers.</small> : null}
  </label>;
}
