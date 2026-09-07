import { AGENT_COLOURS } from "../../lib/agent-colours";
export function AgentColourPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <fieldset className="agent-colour">
    <legend>Colour</legend>
    <div className="agent-colour__presets">
      {AGENT_COLOURS.map(([name, colour]) => <button key={name} type="button" className="agent-colour__swatch" aria-label={name} aria-pressed={value.toLowerCase() === colour.toLowerCase()} title={name} onClick={() => onChange(colour)}>
        <span style={{ background: colour }}>{value.toLowerCase() === colour.toLowerCase() ? "✓" : ""}</span>
      </button>)}
    </div>
  </fieldset>;
}
