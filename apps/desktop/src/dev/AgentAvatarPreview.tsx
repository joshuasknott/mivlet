import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "../components/agents/agent-icons";
import { AVATAR_SHAPES } from "../lib/blob-avatar";
import { AGENT_COLOURS } from "../lib/agent-colours";
import { PRESENCE_LABELS, type AgentPresence } from "../lib/agent-presence";
import "./AgentAvatarPreview.css";

type Surface = "light" | "dark";
type SurfaceMode = Surface | "both";

const PREVIEW_STATES = Object.keys(PRESENCE_LABELS) as AgentPresence[];
const UI_SIZES = [[36, "Sidebar"], [44, "Narrow sidebar"], [36, "Header"], [28, "Feed"], [80, "Editor"], [18, "Compact"]] as const;
const PORTRAIT_SIZES = [[112, "Inspect"], ...UI_SIZES] as const;
const SEQUENCE = [
  { presence: "received" as const, label: "Starting", duration: 550 },
  { presence: "thinking" as const, label: "Thinking", duration: 1_250 },
  { presence: "working" as const, label: "Working", duration: 1_650 },
  { presence: "waiting" as const, label: "Approval", duration: 1_100 },
  { presence: "working" as const, label: "Resuming", duration: 1_100 },
  { presence: "done" as const, label: "Completed", duration: 900 },
];

/** Development-only state board. Controls here never enter the product shell. */
export function AgentAvatarPreview() {
  const [presence, setPresence] = useState<AgentPresence>("idle");
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("both");
  const [colour, setColour] = useState<string>(AGENT_COLOURS[0]?.[1] ?? "#865DFA");
  const [colourOverride, setColourOverride] = useState(false);
  const [selectedCharacter, setSelectedCharacter] = useState(0);
  const [activityKey, setActivityKey] = useState("preview:0");
  const [sequenceLabel, setSequenceLabel] = useState("Ready for a simulated sequence");
  const [sequenceRunning, setSequenceRunning] = useState(false);
  const [uploadedPortrait, setUploadedPortrait] = useState<string>();
  const [restoredPreviewKey, setRestoredPreviewKey] = useState(0);
  const sequenceTimer = useRef<number | undefined>(undefined);
  const sequenceId = useRef(0);

  const bumpActivity = (reason: string) => {
    sequenceId.current += 1;
    setActivityKey(`preview:${reason}:${sequenceId.current}`);
  };

  const stopSequence = () => {
    if (sequenceTimer.current !== undefined) window.clearTimeout(sequenceTimer.current);
    sequenceTimer.current = undefined;
    setSequenceRunning(false);
    setPresence("paused");
    setSequenceLabel("Stopped immediately · simulated");
  };

  const runSequence = () => {
    if (sequenceTimer.current !== undefined) window.clearTimeout(sequenceTimer.current);
    const runId = ++sequenceId.current;
    setSequenceRunning(true);
    setActivityKey(`preview:sequence:${runId}`);
    let step = 0;
    const tick = () => {
      if (runId !== sequenceId.current) return;
      const current = SEQUENCE[step];
      if (!current) {
        sequenceTimer.current = undefined;
        setSequenceRunning(false);
        return;
      }
      setPresence(current.presence);
      setSequenceLabel(`${current.label} · simulated`);
      step += 1;
      if (step < SEQUENCE.length) sequenceTimer.current = window.setTimeout(tick, current.duration);
      else {
        sequenceTimer.current = undefined;
        sequenceTimer.current = window.setTimeout(() => {
          if (runId === sequenceId.current) setSequenceRunning(false);
        }, current.duration);
      }
    };
    tick();
  };

  useEffect(() => () => {
    if (sequenceTimer.current !== undefined) window.clearTimeout(sequenceTimer.current);
  }, []);

  const choosePresence = (next: AgentPresence) => {
    if (sequenceTimer.current !== undefined) window.clearTimeout(sequenceTimer.current);
    sequenceTimer.current = undefined;
    sequenceId.current += 1;
    setSequenceRunning(false);
    setPresence(next);
    setSequenceLabel(`${PRESENCE_LABELS[next]} · simulated`);
  };

  const switchCharacter = (index: number) => {
    if (sequenceTimer.current !== undefined) window.clearTimeout(sequenceTimer.current);
    sequenceTimer.current = undefined;
    setSelectedCharacter(index);
    setSequenceRunning(false);
    setPresence("idle");
    bumpActivity(`identity-${index}`);
    setSequenceLabel(`${AVATAR_SHAPES[index]} selected · reset to Ready · simulated identity switch`);
  };

  const onUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") setUploadedPortrait(reader.result);
    });
    reader.readAsDataURL(file);
  };

  const surfaces: Surface[] = surfaceMode === "both" ? ["light", "dark"] : [surfaceMode];
  const customColour = colourOverride && /^#[0-9a-f]{6}$/i.test(colour) ? colour : undefined;

  return (
    <main className="avatar-preview" aria-labelledby="avatar-preview-title">
      <header className="avatar-preview__header">
        <div>
          <p className="avatar-preview__eyebrow">Development preview · no provider execution</p>
          <h1 id="avatar-preview-title">Agent characters</h1>
          <p className="avatar-preview__intro">Eight coded characters, shown at their real shell sizes. Controls below simulate execution events so motion can be checked without implying live activity.</p>
        </div>
        <div className="avatar-preview__status" role="status" aria-live="polite"><span className={`avatar-preview__status-dot${sequenceRunning ? " is-active" : ""}`} /><span>{sequenceLabel}</span></div>
      </header>

      <section className="avatar-preview__controls" aria-label="Simulation controls">
        <label className="avatar-preview__control"><span>Simulated state</span><select aria-label="Simulated state" value={presence} onChange={(event) => choosePresence(event.target.value as AgentPresence)}>{PREVIEW_STATES.map((state) => <option key={state} value={state}>{PRESENCE_LABELS[state]}</option>)}</select></label>
        <label className="avatar-preview__control avatar-preview__control--colour"><span>Colour override</span><span className="avatar-preview__colour-input"><input aria-label="Use custom avatar colour" type="checkbox" checked={colourOverride} onChange={(event) => setColourOverride(event.target.checked)} /><input aria-label="Custom avatar colour" type="color" value={colour} onChange={(event) => { setColour(event.target.value); setColourOverride(true); }} /><input aria-label="Custom avatar colour hex" value={colourOverride ? colour : "Native colours"} onChange={(event) => { setColour(event.target.value); setColourOverride(true); }} spellCheck={false} /></span></label>
        <label className="avatar-preview__control"><span>Surface</span><select aria-label="Preview surface" value={surfaceMode} onChange={(event) => setSurfaceMode(event.target.value as SurfaceMode)}><option value="both">Light + dark</option><option value="light">Light only</option><option value="dark">Dark only</option></select></label>
        <div className="avatar-preview__actions"><button type="button" onClick={runSequence} disabled={sequenceRunning}>Run realistic sequence</button><button type="button" className="avatar-preview__stop" onClick={stopSequence}>Stop now</button></div>
        <label className="avatar-preview__upload"><span>Uploaded portrait test</span><input aria-label="Upload a portrait for avatar testing" type="file" accept="image/*" onChange={onUpload} /></label>
        {uploadedPortrait ? <button type="button" className="avatar-preview__clear" onClick={() => setUploadedPortrait(undefined)}>Clear uploaded portrait</button> : null}
      </section>

      <section className="avatar-preview__identity" aria-label="Character selection"><div><strong>Switch identity mid-sequence</strong><span>Selecting a character fences the current activity key so an old animation cannot follow it.</span></div><div className="avatar-preview__identity-list">{AVATAR_SHAPES.map((shape, index) => <button key={shape} type="button" className={selectedCharacter === index ? "is-selected" : ""} onClick={() => switchCharacter(index)} aria-pressed={selectedCharacter === index}><AgentAvatar seed={`robot-v3:${index}:preview`} color={customColour} iconSize={30} presence={presence} activityKey={activityKey} /><span>{shape}</span></button>)}</div></section>

      {surfaces.map((surface) => <section key={surface} className="avatar-preview__surface" data-surface={surface} aria-label={`${surface} avatar surface`}><div className="avatar-preview__surface-heading"><div><h2>{surface === "light" ? "Light surface" : "Dark surface"}</h2><span>Active preview · {PRESENCE_LABELS[presence]}</span></div><span className="avatar-preview__simulated-tag">SIMULATED</span></div><div className="avatar-preview__grid">{AVATAR_SHAPES.map((shape, index) => <article key={shape} className={`avatar-preview__card${selectedCharacter === index ? " is-selected" : ""}`}><div className="avatar-preview__card-heading"><strong>{shape}</strong><span>#{index + 1}</span></div><button type="button" className="avatar-preview__hero" onClick={() => switchCharacter(index)} aria-label={`Select ${shape} character`}><AgentAvatar seed={`robot-v3:${index}:preview`} color={customColour} iconSize={112} presence={presence} motion="expressive" activityKey={activityKey} /></button><div className="avatar-preview__size-row" aria-label={`${shape} actual interface sizes`}>{UI_SIZES.map(([size, label]) => <span key={label}><AgentAvatar seed={`robot-v3:${index}:preview`} color={customColour} iconSize={size} presence={presence} motion={label === "Header" || label === "Feed" ? "expressive" : "quiet"} activityKey={activityKey} /><small>{label}<br />{size}px</small></span>)}</div><span className="avatar-preview__state-label">{PRESENCE_LABELS[presence]}</span></article>)}</div></section>)}

      <section className="avatar-preview__lower-grid"><article className="avatar-preview__panel"><div className="avatar-preview__panel-heading"><div><h2>Every supported state</h2><span>{AVATAR_SHAPES[selectedCharacter]} · quiet state reference</span></div><span className="avatar-preview__simulated-tag">SIMULATED</span></div><div className="avatar-preview__state-grid">{PREVIEW_STATES.map((state) => <button key={state} type="button" className={state === presence ? "is-selected" : ""} onClick={() => choosePresence(state)}><AgentAvatar seed={`robot-v3:${selectedCharacter}:state-reference`} color={customColour} iconSize={34} presence={state} motion="quiet" activityKey={`reference:${state}`} /><span>{state === "done" ? "Finished (settled)" : PRESENCE_LABELS[state]}</span></button>)}</div></article><article className="avatar-preview__panel avatar-preview__portrait-panel"><div className="avatar-preview__panel-heading"><div><h2>Custom portrait</h2><span>Uploaded images keep their source and skip generated recolouring</span></div><span className="avatar-preview__simulated-tag">LOCAL FILE</span></div><div className="avatar-preview__portrait-content">{uploadedPortrait ? <div className="avatar-preview__portrait-sizes">{PORTRAIT_SIZES.map(([size, label]) => <span key={label}><AgentAvatar seed={`robot-v3:${selectedCharacter}:uploaded`} imageDataUrl={uploadedPortrait} color={customColour} iconSize={size} presence={presence} motion={size === 112 ? "expressive" : "quiet"} activityKey={activityKey} /><small>{label}<br />{size}px</small></span>)}</div> : <div className="avatar-preview__portrait-empty">Choose an image above to test a saved portrait.</div>}<div><strong>{AVATAR_SHAPES[selectedCharacter]}</strong><span>Saved image at inspection and interface sizes</span><span>Upload is preview-only and is never saved.</span></div></div></article></section>

      <section className="avatar-preview__restored" aria-label="Restored completion example"><div><strong>Restored completion</strong><span>Mounted as an already-finished conversation; it should stay settled.</span></div><AgentAvatar key={restoredPreviewKey} seed={`robot-v3:${selectedCharacter}:restored`} color={customColour} iconSize={44} presence="done" motion="expressive" activityKey={`restored:${restoredPreviewKey}`} /><button type="button" onClick={() => setRestoredPreviewKey((key) => key + 1)}>Remount restored example</button></section>
    </main>
  );
}
