import { useEffect, useRef, type KeyboardEvent } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
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
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const selected = models.find((model) => model.id === selectedId);
  const providers = [...new Set(models.map((model) => model.providerId))];
  const reasoning = selected?.reasoning;
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const close = () => { onOpenChange(false); trigger.current?.focus(); };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  return <div className="composer-control-anchor composer-control-anchor--model" ref={root}
    onKeyDown={navigate} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onOpenChange(false); }}>
    <button ref={trigger} type="button" className={`composer-model${open ? " composer-trigger--open" : ""}`}
      aria-label="Select model" aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <span>{label}</span>
      {effort ? <small className="composer-model__effort">{effortLabel(effort)}</small> : null}
      <CaretDown size={13} />
    </button>
    {open ? <div className="composer-menu model-picker" role="menu" aria-label="Models">
      <div className="model-picker__models">
        {allowAutomatic ? <button type="button" role="menuitemradio" aria-checked={!selectedId} onClick={() => onSelect("")}>
          <span>Automatic</span>{!selectedId ? <Check size={15} aria-hidden="true" /> : null}
        </button> : null}
        {!models.length ? <p className="model-picker__note">Connect a provider to choose a model.</p> : null}
        {providers.map((id) => <div key={id} role="group" aria-label={models.find((model) => model.providerId === id)?.providerLabel}>
          <div className="model-picker__heading"><ProviderIcon provider={id} size={16} />{models.find((model) => model.providerId === id)?.providerLabel}</div>
          {models.filter((model) => model.providerId === id).map((model) =>
            <button type="button" role="menuitemradio" key={model.id} disabled={!model.available}
              aria-checked={selectedId === model.id} aria-label={`${model.providerLabel} ${model.label}${model.available ? "" : ", unavailable"}`}
              onClick={() => onSelect(model.id)}>
              <span>{model.label}</span>{selectedId === model.id ? <Check size={15} aria-hidden="true" /> : null}
            </button>)}
        </div>)}
      </div>
      {reasoning?.supportedEfforts.length && onSelectEffort ? <div className="model-picker__reasoning" role="group" aria-label="Reasoning level">
        <span className="model-picker__heading">Reasoning</span>
        <button type="button" role="menuitemradio" aria-checked={!effort} onClick={() => { onSelectEffort(undefined); close(); }}>
          <span>Default{reasoning.defaultEffort ? <small>{effortLabel(reasoning.defaultEffort)}</small> : null}</span>
          {!effort ? <Check size={15} aria-hidden="true" /> : null}
        </button>
        {reasoning.supportedEfforts.map((level) => <button type="button" role="menuitemradio" key={level}
          aria-checked={effort === level} onClick={() => { onSelectEffort(level); close(); }}>
          <span>{effortLabel(level)}</span>{effort === level ? <Check size={15} aria-hidden="true" /> : null}
        </button>)}
        <p className="model-picker__note">More effort can take longer and use more tokens.</p>
      </div> : null}
    </div> : null}
  </div>;
}
