import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { MarketplaceIcon } from "./MarketplaceIcon";
import type { BuiltinPluginEntry } from "../../lib/builtin-plugins";

/**
 * A built-in plugin renders as an ordinary catalogue card. Enablement is
 * distinct from connection readiness and changes only in its detail view.
 */
export function BuiltinPluginCard({
  entry,
  enabled,
  unavailable,
  onOpen,
}: {
  entry: BuiltinPluginEntry;
  enabled: boolean;
  unavailable: boolean;
  onOpen: () => void;
}) {
  const label = enabled ? `Manage ${entry.name}` : `Set up ${entry.name}`;
  return (
    <button
      type="button"
      className="marketplace-connector-row"
      data-connector-id={entry.id}
      data-availability="available"
      aria-label={label}
      onClick={onOpen}
    >
      <span className="marketplace-connector-icon" aria-hidden="true">
        <MarketplaceIcon id={entry.id} />
      </span>
      <span className="marketplace-connector-row__copy">
        <strong>{entry.name}</strong>
        <span>{entry.description}</span>
        <small>{unavailable ? "Unavailable" : enabled ? "Enabled" : "Disabled"}</small>
      </span>
      <span
        className={`marketplace-connector-row__action${enabled ? " marketplace-connector-row__action--enabled" : ""}`}
        aria-hidden="true"
      >
        {enabled ? <Check size={19} weight="bold" /> : <Plus size={19} />}
      </span>
    </button>
  );
}
