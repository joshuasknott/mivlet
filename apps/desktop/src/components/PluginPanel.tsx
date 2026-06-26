import type { ConnectorManifest } from "@arden/protocol";
import { SectionHeading, StatusDot } from "./primitives";

/**
 * Plugins context panel: connector manifests with health status, permission
 * chips, and a "use in composer" / "prepare auth" action.
 */

export function PluginPanel({
  manifests,
  onUseConnector
}: {
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
}) {
  return (
    <section className="context-panel" aria-label="Plugins">
      <SectionHeading title="Plugins" meta="bridges and permissions" />
      <div className="connector-grid">
        {manifests.map((connector) => {
          const ready = connector.status === "connected" || connector.status === "fixture";
          return (
            <article className="connector-card" key={connector.id}>
              <div className="connector-card__top">
                <span>
                  <strong>{connector.name}</strong>
                  <small>{connector.healthSummary}</small>
                </span>
                <StatusDot tone={ready ? "ready" : "needs-auth"} />
              </div>
              <div className="permission-list">
                {connector.permissions.map((permission) => (
                  <span key={permission}>{permission}</span>
                ))}
              </div>
              <button type="button" onClick={() => onUseConnector(connector)}>
                {ready ? "Use in composer" : "Prepare auth"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
