import { useState } from "react";
import type { ProviderUsageModel, ProviderUsageReport } from "@mivlet/protocol";
import {
  resetProviderUsagePrice,
  saveProviderUsagePrice,
} from "../../runtime/domains/provider-usage";
import { timestamp } from "./usage-data";

export function UsagePriceEditor({
  model,
  report,
  onSave,
}: {
  model: ProviderUsageModel;
  report: ProviderUsageReport;
  onSave: () => Promise<void>;
}) {
  const price = report.prices.find(
    (p) => p.providerId === model.providerId && p.model === model.model,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <details className="usage-price-editor">
      <summary>
        {price ? "Pricing and overrides" : "Set an exact-model price"}
      </summary>
      <p>
        {price?.origin === "automatic"
          ? "Current standard API rates from LiteLLM."
          : price
            ? "Your exact-model override."
            : "No trusted exact-model price is available."}{" "}
        Rates apply to this model's history in this workspace. Subscription
        estimates are not a bill. Unknown cache rates leave affected receipts
        unpriced.
      </p>
      {price ? (
        <p className="usage-price-editor__source">
          <a href={price.source} target="_blank" rel="noreferrer">
            Pricing source
          </a>
          <span>Observed {timestamp(price.observedAt)}</span>
        </p>
      ) : null}
      <form
        key={`${price?.origin}:${price?.observedAt}`}
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError("");
          const values = new FormData(event.currentTarget);
          const optional = (name: string) =>
            values.get(name) === "" ? undefined : Number(values.get(name));
          try {
            await saveProviderUsagePrice({
              providerId: model.providerId,
              model: model.model,
              inputPerMillionUsd: Number(values.get("input")),
              outputPerMillionUsd: Number(values.get("output")),
              cachedInputPerMillionUsd: optional("cached"),
              cacheWritePerMillionUsd: optional("write"),
              source: String(values.get("source")),
              observedAt: new Date(
                `${String(values.get("observed"))}T00:00:00Z`,
              ).toISOString(),
            });
            await onSave();
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Rates could not be saved.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="usage-price-editor__fields">
          {(
            [
              ["input", "Input", price?.inputPerMillionUsd],
              ["output", "Output", price?.outputPerMillionUsd],
              ["cached", "Cache read", price?.cachedInputPerMillionUsd],
              ["write", "Cache write", price?.cacheWritePerMillionUsd],
            ] as const
          ).map(([name, label, value]) => (
            <label key={name}>
              {label} · USD / 1M
              <input
                name={name}
                type="number"
                min={0}
                max={10000}
                step="any"
                required={name === "input" || name === "output"}
                defaultValue={value ?? ""}
              />
            </label>
          ))}
          <label>
            HTTPS pricing source
            <input
              type="url"
              name="source"
              required
              placeholder="https://"
              defaultValue={price?.source ?? ""}
            />
          </label>
          <label>
            Observation date
            <input
              type="date"
              name="observed"
              required
              max={new Date().toISOString().slice(0, 10)}
              defaultValue={(
                price?.observedAt ?? new Date().toISOString()
              ).slice(0, 10)}
            />
          </label>
        </div>
        <div className="usage-price-editor__actions">
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save override"}
          </button>
          {price && price.origin !== "automatic" ? (
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                setError("");
                try {
                  await resetProviderUsagePrice(model.providerId, model.model);
                  await onSave();
                } catch {
                  setError("The override could not be reset. Try again.");
                } finally {
                  setPending(false);
                }
              }}
            >
              Reset to automatic
            </button>
          ) : null}
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </details>
  );
}
