import { useState } from "react";
import type { ProviderModelOption } from "../../lib/provider-models";

export function ProviderModelSettings({ models, hiddenModelIds, onChange }: {
  models: ProviderModelOption[];
  hiddenModelIds: string[];
  onChange: (id: string, visible: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const providers = [...new Map(models.map((model) => [model.providerId, model.providerLabel])).entries()];
  const availableCount = models.filter((model) => model.available).length;
  return <section className="provider-model-settings" aria-label="Models in conversations">
    <div className="settings-section-heading"><h2>Available models <span className="provider-model-settings__count">{availableCount} available</span></h2><p>Choose which models appear in conversations.</p></div>
    {!models.length ? <p className="provider-catalogue__empty">Connect a provider to see its models here.</p> : null}
    <input className="input" type="search" aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => setQuery(event.target.value)} />
    {providers.map(([id, label]) => {
      const catalogue = models.filter((model) => model.providerId === id);
      const visible = catalogue.filter((model) => `${model.label} ${model.modelId}`.toLowerCase().includes(query.trim().toLowerCase()));
      const selected = catalogue.filter((model) => !hiddenModelIds.includes(model.id));
      return <details className="settings-disclosure" key={id} open>
        <summary>{label}<span>{selected.length} of {catalogue.length} shown</span></summary>
        <div className="provider-model-settings__actions">
          <button type="button" onClick={() => catalogue.forEach((model) => onChange(model.id, true))}>Show all</button>
          <button type="button" onClick={() => catalogue.forEach((model) => onChange(model.id, false))}>Hide all</button>
        </div>
        <div className="provider-model-settings__list">
          {visible.map((model) => <label className="provider-model-settings__row" key={model.id}>
            <input type="checkbox" checked={!hiddenModelIds.includes(model.id)} onChange={(event) => onChange(model.id, event.target.checked)} />
            <span><strong>{model.label}</strong><small>{model.modelId}</small></span>
            <small className="provider-model-settings__availability" data-available={model.available}>{model.available ? "Available" : "Unavailable"}</small>
          </label>)}
          {!visible.length ? <p>No matching models.</p> : null}
        </div>
      </details>;
    })}
  </section>;
}
