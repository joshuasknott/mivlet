import { AVATAR_SHAPES, avatarVariant } from "../../lib/blob-avatar";
import { AgentAvatar } from "./agent-icons";
import { AgentColourPicker } from "./AgentColourPicker";
import "./agent-appearance.css";

export function AgentAppearancePicker({ seed, color, imageSelected = false, onChange }: {
  seed: string;
  color: string;
  imageSelected?: boolean;
  onChange: (value: { avatarSeed: string; iconColor: string }) => void;
}) {
  return <div className="character-appearance">
    <fieldset className="character-picker">
      <legend>Icon</legend>
      <div className="character-options" role="group" aria-label="Agent icon">
        {AVATAR_SHAPES.map((name, index) => <button key={name} type="button"
          aria-label={`${name} character`} aria-pressed={!imageSelected && avatarVariant(seed) === index}
          onClick={() => onChange({ avatarSeed: `ink-v1:${index}:${crypto.randomUUID()}`, iconColor: color })}>
          <AgentAvatar seed={`ink-v1:${index}:preview`} color={color} iconSize={44} />
          <span>{name}</span>
        </button>)}
      </div>
    </fieldset>
    <AgentColourPicker value={color} onChange={(iconColor) => onChange({ avatarSeed: seed, iconColor })} />
  </div>;
}
