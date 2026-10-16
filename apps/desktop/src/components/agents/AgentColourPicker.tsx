import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { useEffect, useId, useState } from "react";
import { AGENT_COLOURS, usesLightInk } from "../../lib/agent-colours";

export function AgentColourPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [hex, setHex] = useState(value);
  const id = useId();
  useEffect(() => setHex(value), [value]);
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  return <fieldset className="character-colour">
    <legend>Colour</legend>
    <div className="character-colour__presets">
      {AGENT_COLOURS.map(([name, colour]) => <button key={name} type="button" className="character-colour__swatch" aria-label={name} aria-pressed={value.toLowerCase() === colour.toLowerCase()} title={name} onClick={() => onChange(colour)}>
        <span style={{ background: colour, color: usesLightInk(colour) ? "#fff" : "#14151a" }}>{value.toLowerCase() === colour.toLowerCase() && <Check size={16} weight="bold" />}</span>
      </button>)}
    </div>
    <div className="character-colour__custom">
      <label className="character-colour__native"><input type="color" aria-label="Choose custom icon colour" value={value} onChange={(event) => onChange(event.target.value)} /><span>Custom</span></label>
      <label className="character-colour__hex"><span className="character-appearance__sr-only">Icon hex colour</span><input type="text" value={hex} maxLength={7} pattern="#[0-9a-fA-F]{6}" required spellCheck={false} aria-invalid={!valid} aria-describedby={!valid ? id : undefined}
        onChange={(event) => { const next = event.target.value; setHex(next); if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toUpperCase()); }} /></label>
    </div>
    {!valid && <small id={id} className="character-colour__error">Use a six-digit hex colour, such as #B8CCFF.</small>}
  </fieldset>;
}
