import type { RunStatusMeta } from "../lib/run-status";

/**
 * A compact status pill shared by the run list and detail view. The tone maps
 * to a CSS modifier so both surfaces always render the same color for a state.
 */
export function RunStatusBadge({ meta }: { meta: RunStatusMeta }) {
  return (
    <span className={`run-badge run-badge--${meta.tone}`} title={meta.hint}>
      <span className="run-badge__dot" aria-hidden="true" />
      {meta.label}
    </span>
  );
}
