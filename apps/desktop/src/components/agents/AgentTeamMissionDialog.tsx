import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { FableAgentProfile } from "@fable/protocol";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { agentExecutionInstructions } from "../../lib/agent-learning";
import { ProfileAgentAvatar } from "./agent-icons";

const MAX_TEAMMATES = 5;

function compactLine(value: string, maximum: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function buildAgentTeamMissionCommand(
  objective: string,
  agents: FableAgentProfile[]
): string | null {
  const cleanObjective = compactLine(objective, 500);
  if (!cleanObjective || agents.length < 2 || agents.length > MAX_TEAMMATES) return null;
  const title = compactLine(cleanObjective, 150);
  const tasks = agents.map((agent) => {
    const name = compactLine(agent.name, 80) || "Teammate";
    const role = compactLine(agentExecutionInstructions(agent), 620)
      || "Contribute your strongest independent analysis and make concrete recommendations.";
    return `- ${name}: Work from this teammate brief: ${role} Outcome: ${cleanObjective}`;
  });
  return [
    `/mission ${title}`,
    ...tasks,
    `all: Combine the teammates' work into one clear answer for this outcome: ${cleanObjective}`,
    `accept: The final answer directly addresses this outcome: ${cleanObjective}`
  ].join("\n");
}

export function AgentTeamMissionDialog({
  open,
  agents,
  activeAgentId,
  busy,
  onClose,
  onLaunch
}: {
  open: boolean;
  agents: FableAgentProfile[];
  activeAgentId: string;
  busy: boolean;
  onClose: () => void;
  onLaunch: (command: string, objective: string) => void;
}) {
  const [objective, setObjective] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const dialogRef = useRef<HTMLElement>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  useModalFocusTrap({ active: open, containerRef: dialogRef, initialFocusRef: objectiveRef, onClose });

  useEffect(() => {
    if (!open) return;
    const firstOther = agents.find((agent) => agent.id !== activeAgentId);
    setObjective("");
    setSelectedIds([
      activeAgentId,
      ...(firstOther ? [firstOther.id] : [])
    ]);
  }, [activeAgentId, agents, open]);

  const selectedAgents = useMemo(
    () => selectedIds
      .map((id) => agents.find((agent) => agent.id === id))
      .filter((agent): agent is FableAgentProfile => Boolean(agent)),
    [agents, selectedIds]
  );
  const command = buildAgentTeamMissionCommand(objective, selectedAgents);

  if (!open) return null;

  const toggleAgent = (id: string) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : current.length < MAX_TEAMMATES ? [...current, id] : current);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!command || busy) return;
    onLaunch(command, compactLine(objective, 500));
  };

  return (
    <div className="agent-team-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className="agent-team-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-team-title"
        tabIndex={-1}
      >
        <header className="agent-team-dialog__header">
          <div>
            <span><UsersThree size={15} aria-hidden="true" /> Team mission</span>
            <h2 id="agent-team-title">Bring in teammates</h2>
            <p>Each teammate works independently, then Fable combines their work.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close team mission"><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          <label className="agent-team-dialog__objective">
            <span>What should the team accomplish?</span>
            <textarea
              ref={objectiveRef}
              rows={4}
              maxLength={500}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Compare the launch options and recommend the safest path..."
            />
          </label>
          <fieldset className="agent-team-dialog__roster">
            <legend>Choose 2–5 teammates</legend>
            {agents.map((candidate) => {
              const selected = selectedIds.includes(candidate.id);
              const unavailable = !selected && selectedIds.length >= MAX_TEAMMATES;
              return (
                <label key={candidate.id} className={selected ? "is-selected" : ""}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={unavailable}
                    onChange={() => toggleAgent(candidate.id)}
                  />
                  <ProfileAgentAvatar agent={candidate} iconSize={20} />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>{candidate.instructions.trim() || "Ready for a teammate brief"}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <footer>
            <span>{selectedAgents.length} teammate{selectedAgents.length === 1 ? "" : "s"} selected</span>
            <div>
              <button type="button" onClick={onClose}>Cancel</button>
              <button className="agent-team-dialog__launch" type="submit" disabled={!command || busy}>
                {busy ? "Team is busy" : "Start team mission"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
