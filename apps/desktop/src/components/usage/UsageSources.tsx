import { useState } from "react";
import type { ProviderUsageReport } from "@mivlet/protocol";
import {
  clearImportedProviderUsage,
  importProviderUsageHistory,
} from "../../runtime/domains/provider-usage";
import { number, timestamp } from "./usage-data";

export function UsageSources({
  report,
  onChange,
}: {
  report: ProviderUsageReport;
  onChange: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
      await onChange();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Usage sources could not be updated.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <details className="usage-sources">
      <summary>Coverage and pricing</summary>
      <p>
        Mivlet counts each saved attempt once, including partial failed and
        interrupted attempts. Imported history is a separate view and is never
        added to Mivlet totals. Provider limits cover the connected subscription
        independently.
      </p>
      {(report.missingUsageAttempts ?? 0) > 0 ? (
        <p>
          {number(report.missingUsageAttempts!)} attempts in this period have no
          token receipt and are excluded.
        </p>
      ) : null}
      <p>
        Automatic estimates use exact-model standard API rates from{" "}
        <a
          href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
          target="_blank"
          rel="noreferrer"
        >
          LiteLLM
        </a>
        , refreshed daily when history opens. Source and observation date are
        available per model. Ambiguous models, unsupported providers, missing
        cache rates and unavailable pricing remain unpriced. Receipts without a
        recorded standard service tier need an override; speed premiums are not
        guessed.
      </p>
      {report.pricing ? (
        <p>
          Price catalogue: {report.pricing.status} · Observed{" "}
          {timestamp(report.pricing.observedAt)}
          {report.pricing.reason ? ` · ${report.pricing.reason}` : ""}
        </p>
      ) : null}
      <h4>Import activity from other apps</h4>
      <p>
        Choose Codex or Claude session JSONL files in the native file picker.
        Only token measurements, model IDs and dates are saved in this encrypted
        workspace. Files are read once; auth files and other folders are never
        scanned. Reimporting the same sessions replaces matching receipts.
        Forked Codex history and records without stable IDs are excluded.
      </p>
      <div className="usage-sources__actions">
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(() => importProviderUsageHistory("codex"))}
        >
          Import Codex history
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(() => importProviderUsageHistory("claude"))}
        >
          Import Claude history
        </button>
        {report.imports?.records ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(clearImportedProviderUsage)}
          >
            Remove imported measurements
          </button>
        ) : null}
      </div>
      {report.imports?.importedAt ? (
        <p>
          {number(report.imports.records)} imported receipts · Last import{" "}
          {timestamp(report.imports.importedAt)}
          {report.imports.skipped
            ? ` · ${number(report.imports.skipped)} records or files excluded in the last import`
            : ""}
          .
        </p>
      ) : null}
      {pending ? <p role="status">Updating imported measurements…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
