import { useState } from "react";
import { AgentAvatar } from "../components/agents/agent-icons";
import { AVATAR_SHAPES } from "../lib/blob-avatar";
import { AGENT_COLOURS } from "../lib/agent-colours";
import { PRESENCE_LABELS, type AgentPresence } from "../lib/agent-presence";

/** Development-only state board. These controls never enter the product shell. */
export function AgentAvatarPreview() {
  const [presence, setPresence] = useState<AgentPresence>("idle");
  const [dark, setDark] = useState(false);
  const [colour, setColour] = useState("");
  return <main style={{ minHeight: "100vh", padding: 24, color: dark ? "#f5f5f5" : "#252525", background: dark ? "#15171c" : "#faf9f6", fontFamily: "Inter, sans-serif" }}>
    <h1 style={{ fontSize: 22 }}>Agent characters</h1>
    <p>Development preview · Simulated states, no provider execution</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, margin: "24px 0" }}>
      <label>State <select aria-label="State" value={presence} onChange={(event) => setPresence(event.target.value as AgentPresence)}>
        {Object.entries(PRESENCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Colour <select aria-label="Colour" value={colour} onChange={(event) => setColour(event.target.value)}>
        <option value="">Original</option>{AGENT_COLOURS.map(([name, value]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      <label><input type="checkbox" checked={dark} onChange={(event) => setDark(event.target.checked)} /> Dark background</label>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 20, maxWidth: 1000 }}>
      {AVATAR_SHAPES.map((shape, index) => <section key={shape} style={{ padding: 16, border: "1px solid #8884", borderRadius: 16, display: "grid", justifyItems: "center", gap: 14 }}>
        <AgentAvatar seed={`robot-v3:${index}:preview`} color={colour || undefined} iconSize={112} presence={presence} motion="expressive" />
        <strong>{shape}</strong>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><AgentAvatar seed={`robot-v3:${index}:preview`} color={colour || undefined} iconSize={32} presence={presence} /><AgentAvatar seed={`robot-v3:${index}:preview`} color={colour || undefined} iconSize={18} presence={presence} /></div>
        <span style={{ fontSize: 12 }}>{PRESENCE_LABELS[presence]}</span>
      </section>)}
    </div>
  </main>;
}
