import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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

export function ModelPicker({ models, selectedId, label, effort, onSelect, onSelectEffort, open, onOpenChange, allowAutomatic = false }: {
  models: ProviderModelOption[];
  selectedId: string;
  label: string;
  effort?: string;
  onSelect: (id: string) => void;
  onSelectEffort?: (effort: string | undefined) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowAutomatic?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
      aria-label="Select model" aria-haspopup="dialog" aria-controls={open ? panelId : undefined} aria-expanded={open}
      onClick={() => { if (!open) { setView("effort"); setQuery(""); setProvider(""); } onOpenChange(!open); }}>
      <span>{label}</span>
      {selected?.reasoning?.supportedEfforts.length ? <small className="composer-model__effort">{currentEffort ? effortLabel(currentEffort) : "Default"}</small> : null}
      <CaretDown size={13} />
    </button>
    {open ? <div id={panelId} className={`composer-menu model-picker${showEffort ? " model-picker--effort" : ""}`} role="dialog" aria-label="Model and reasoning">
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
        <div className="model-picker__scale" aria-hidden="true"><span>{effortLabel(levels[0])}</span><span>{effortLabel(levels[levels.length - 1])}</span></div>
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
