import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import type { ProviderModelOption } from "../lib/provider-models";
import { ProviderIcon } from "./ProviderIcon";

const EFFORT_LABELS: Record<string, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra"
};
const effortLabel = (value: string) => EFFORT_LABELS[value] ?? value;

// Panel placement: the stylesheet anchors the panel to the trigger's far edge,
// which runs past the workspace scroll container (and the navigation beside it)
// whenever the trigger sits near that edge. These bound the measured fallback.
const PANEL_GUTTER = 12;
const PANEL_MAX_HEIGHT = 400;
const PANEL_MIN_HEIGHT = 96;
const FLIP_BELOW_THRESHOLD = 176;

export function ModelPicker({ models, selectedId, label, effort, onSelect, onSelectEffort, open, onOpenChange, allowAutomatic = false, scopeLabel }: {
  models: ProviderModelOption[];
  selectedId: string;
  label: string;
  effort?: string;
  onSelect: (id: string) => void;
  onSelectEffort?: (effort: string | undefined) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowAutomatic?: boolean;
  scopeLabel?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [view, setView] = useState<"effort" | "models">("effort");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const selected = models.find((model) => model.id === selectedId);
  const providers = [...new Map(models.map((model) => [model.providerId, model.providerLabel])).entries()];
  const levels = selected?.available && onSelectEffort ? selected.reasoning?.supportedEfforts ?? [] : [];
  const currentEffort = effort ?? selected?.reasoning?.defaultEffort;
  const effortIndex = Math.max(0, levels.indexOf(currentEffort ?? ""));
  const showEffort = view === "effort" && levels.length > 0;
  const activeProvider = providers.some(([id]) => id === provider) ? provider : "";
  const visibleModels = models.filter((model) => (!activeProvider || model.providerId === activeProvider)
    && `${model.label} ${model.providerLabel}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(showEffort ? '[type="range"]' : '[type="search"]')?.focus();
  }, [open, showEffort]);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = root.current;
    const menu = panel.current;
    if (!anchor || !menu) return;
    // Keep the panel anchored to its trigger but inside the viewport and every
    // clipping ancestor between it and the document. Skipped when the
    // responsive layout owns placement (static anchor) or nothing is
    // measurable, leaving the stylesheet defaults.
    const place = () => {
      const anchorBox = anchor.getBoundingClientRect();
      // Hand placement back to the stylesheet when the responsive layout
      // owns the anchor or nothing is measurable; stale inline placement
      // would otherwise carry across layout modes.
      const release = () => {
        menu.style.left = "";
        menu.style.right = "";
        menu.style.width = "";
        menu.style.maxHeight = "";
        menu.style.top = "";
        menu.style.bottom = "";
      };
      if (!anchorBox.width && !anchorBox.height) { release(); return; }
      if (getComputedStyle(anchor).position === "static") { release(); return; }
      // Re-measure from the stylesheet width: a previously clamped inline
      // width would otherwise become the new natural width forever.
      menu.style.width = "";
      const naturalWidth = menu.offsetWidth || menu.getBoundingClientRect().width;
      if (!naturalWidth) return;
      let frame = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent);
        if (overflow.overflow === "visible" && overflow.overflowX === "visible" && overflow.overflowY === "visible") continue;
        const box = parent.getBoundingClientRect();
        frame = {
          left: Math.max(frame.left, box.left),
          top: Math.max(frame.top, box.top),
          right: Math.min(frame.right, box.right),
          bottom: Math.min(frame.bottom, box.bottom)
        };
      }
      const availableWidth = frame.right - frame.left - PANEL_GUTTER * 2;
      const panelWidth = Math.min(naturalWidth, Math.max(0, availableWidth));
      if (panelWidth < naturalWidth) menu.style.width = `${panelWidth}px`;
      menu.style.right = "auto";
      const desiredLeft = anchorBox.right - panelWidth;
      const left = Math.min(Math.max(desiredLeft, frame.left + PANEL_GUTTER), Math.max(frame.left + PANEL_GUTTER, frame.right - PANEL_GUTTER - panelWidth));
      menu.style.left = `${Math.round(left - anchorBox.left)}px`;
      const spaceAbove = anchorBox.top - frame.top - PANEL_GUTTER;
      const spaceBelow = frame.bottom - anchorBox.bottom - PANEL_GUTTER;
      const flipBelow = spaceAbove < FLIP_BELOW_THRESHOLD && spaceBelow > spaceAbove;
      menu.style.maxHeight = `${Math.round(Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, flipBelow ? spaceBelow : spaceAbove)))}px`;
      if (flipBelow) { menu.style.bottom = "auto"; menu.style.top = "calc(100% + 6px)"; }
      else { menu.style.top = "auto"; menu.style.bottom = ""; }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, showEffort]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const close = () => { onOpenChange(false); trigger.current?.focus(); };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (showEffort || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : index < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1)
      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
    options[next]?.scrollIntoView?.({ block: "nearest" });
  };
  const chooseModel = (modelId: string) => {
    onSelect(modelId);
    if (onSelectEffort && models.find((model) => model.id === modelId)?.reasoning?.supportedEfforts.length) setView("effort");
    else close();
  };
  return <div className="composer-control-anchor composer-control-anchor--model" ref={root}
    onKeyDown={navigate} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onOpenChange(false); }}>
    <button ref={trigger} type="button" className={`composer-model${open ? " composer-trigger--open" : ""}`}
      aria-label={`Select model: ${label}${currentEffort ? `, ${effortLabel(currentEffort)}` : ""}`} title={scopeLabel}
      aria-haspopup="dialog" aria-controls={open ? panelId : undefined} aria-expanded={open}
      onClick={() => { if (!open) { setView("effort"); setQuery(""); setProvider(""); } onOpenChange(!open); }}>
      <span>{label}</span>
      {selected?.reasoning?.supportedEfforts.length ? <small className="composer-model__effort">{currentEffort ? effortLabel(currentEffort) : "Default"}</small> : null}
      <CaretDown size={13} />
    </button>
    {open ? <div ref={panel} id={panelId} className={`composer-menu model-picker${showEffort ? " model-picker--effort" : ""}`} role="dialog" aria-label="Model and reasoning">
      {scopeLabel ? <p className="model-picker__scope">{scopeLabel}</p> : null}
      {showEffort ? <div className="model-picker__effort-view">
        <div className="model-picker__summary">
          <ProviderIcon provider={selected!.providerId} size={20} />
          <button type="button" className="model-picker__model-link" aria-label="Change model" onClick={() => setView("models")}>
            <strong>{currentEffort ? effortLabel(currentEffort) : "Default"}<CaretRight size={12} /></strong>
            <span title={`${selected!.providerLabel} · ${label}`}>{label}</span>
          </button>
          <button type="button" className="model-picker__reset" aria-label="Reset reasoning to default" title="Reset to default" disabled={!effort} onClick={() => onSelectEffort?.(undefined)}>
            <ArrowCounterClockwise size={16} />
          </button>
        </div>
        <div className="model-picker__slider" style={{ "--effort-progress": `${levels.length > 1 ? effortIndex / (levels.length - 1) * 100 : 0}%` } as CSSProperties}>
          <input type="range" min={0} max={Math.max(0, levels.length - 1)} step={1} value={effortIndex}
            aria-label="Reasoning effort" aria-valuetext={currentEffort ? effortLabel(currentEffort) : "Default"}
            disabled={levels.length < 2} onChange={(event) => onSelectEffort?.(levels[Number(event.target.value)])} />
          <div className="model-picker__ticks" aria-hidden="true">{levels.map((level) => <i key={level} />)}</div>
        </div>
        <div className="model-picker__scale" role="group" aria-label="Reasoning levels">{levels.map(level => <button type="button" key={level} aria-pressed={level === currentEffort} onClick={() => onSelectEffort?.(level)}>{effortLabel(level)}</button>)}</div>
      </div> : <div className="model-picker__browse">
        <div className="model-picker__toolbar">
          {levels.length > 0 ? <button type="button" aria-label="Back to reasoning" onClick={() => setView("effort")}><CaretLeft size={16} /></button> : null}
          <span>Choose model</span><small>{models.length}</small>
        </div>
        <label className="model-picker__search"><MagnifyingGlass size={16} /><input type="search" aria-label="Search models" placeholder="Search models…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {providers.length > 1 ? <div className="model-picker__providers" role="group" aria-label="Filter by provider">
          {[["", "All providers"], ...providers].map(([id, name]) => <button key={id} type="button" aria-pressed={activeProvider === id} onClick={() => setProvider(id)}>{id ? <ProviderIcon provider={id} size={14} /> : null}<span>{name}</span></button>)}
        </div> : null}
        <div className="model-picker__models" role="menu" aria-label="Models">
          {allowAutomatic && !query.trim() && !activeProvider ? <button type="button" role="menuitemradio" aria-checked={!selectedId} onClick={() => chooseModel("")}><span>Automatic</span>{!selectedId ? <Check size={15} /> : null}</button> : null}
          {visibleModels.map((model) => <button type="button" role="menuitemradio" key={model.id} disabled={!model.available}
            aria-checked={selectedId === model.id} aria-label={`${model.providerLabel} ${model.label}${model.available ? "" : ", unavailable"}`} onClick={() => chooseModel(model.id)}>
            <ProviderIcon provider={model.providerId} size={18} /><span className="model-picker__model-name"><span title={model.label}>{model.label}</span><small>{model.providerLabel}{!model.available ? " · Unavailable" : ""}</small></span>
            {selectedId === model.id ? <Check size={15} aria-hidden="true" /> : null}
          </button>)}
          {!visibleModels.length ? <p className="model-picker__note" role="status">{models.length ? "No matching models." : "Connect a provider to choose a model."}</p> : null}
        </div>
      </div>}
    </div> : null}
  </div>;
}
