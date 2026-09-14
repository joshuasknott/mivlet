import { MarketplaceIcon } from "./MarketplaceIcon";
import type { BuiltinPluginEntry } from "../../lib/builtin-plugins";

/**
 * The ordinary plugin detail modal for a built-in plugin. Enablement is kept
 * distinct from connection readiness and never grants foreground input.
 */
export function BuiltinPluginDetails({
  entry,
  enabled,
  unavailable,
  busy,
  notice,
  workspaceId,
  titleId,
  onToggle,
  onUse,
}: {
  entry: BuiltinPluginEntry;
  enabled: boolean;
  unavailable: boolean;
  busy: boolean;
  notice: string;
  workspaceId?: string;
  titleId: string;
  onToggle: (enabled: boolean) => void | Promise<void>;
  onUse?: (id: "computer") => void;
}) {
  const status = busy ? "Saving…" : unavailable ? "Unavailable" : enabled ? "Enabled" : "Disabled";
  return (
    <article className="connector-detail" aria-label={`${entry.name} details`} aria-busy={busy}>
      <p className="connector-detail__eyebrow">Plugins</p>
      <div className="connector-detail__header">
        <span className="marketplace-connector-icon" aria-hidden="true">
          <MarketplaceIcon id={entry.id} />
        </span>
        <div>
          <h2 id={titleId}>{entry.name}</h2>
          <p>{entry.description}</p>
        </div>
        <span className={`connector-detail__status${enabled ? " connector-detail__status--enabled" : ""}`}>{status}</span>
      </div>
      <p className="connector-detail__intro">
        {unavailable
          ? "Computer Use settings belong to the desktop app. Open Mivlet on this PC to enable it."
          : enabled
            ? "Enabled. Agents can use supported application controls while the bundled Windows runtime and a supported model route are available. Enablement alone never grants permission."
            : "Enable Computer Use to let agents operate existing Windows applications. Consequential actions stay bound to your workspace approval preference, and foreground input still needs an approved window selection."}
      </p>
      <div className="connector-detail__actions">
        <button
          type="button"
          className={enabled ? undefined : "button--primary"}
          disabled={unavailable || busy || !workspaceId}
          onClick={() => void onToggle(!enabled)}
        >
          {busy ? "Saving…" : enabled ? "Disable" : "Enable"}
        </button>
        {enabled ? (
          <button type="button" disabled={unavailable || busy || !onUse} onClick={() => onUse?.(entry.id)}>Use in chat</button>
        ) : null}
      </div>
      {notice ? <p className="connector-detail__notice" role="status">{notice}</p> : null}
      <div className="plugin-overview">
        <section className="plugin-overview__about">
          <h3>About this plugin</h3>
          <p>{entry.about}</p>
          <dl>
            <div><dt>Category</dt><dd>Built-in</dd></div>
            <div><dt>Access</dt><dd>{entry.access}</dd></div>
          </dl>
        </section>
      </div>
      <p className="connector-detail__hint">
        {enabled
          ? "Disabling stops any active application control immediately and requires fresh permission before it runs again. Stop stays available from the computer panel and Ctrl+Alt+Esc."
          : "This shares your Windows session rather than an isolated machine, and only some actions are available in the background."}
      </p>
    </article>
  );
}
