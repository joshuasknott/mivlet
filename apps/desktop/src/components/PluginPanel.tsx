import type { ConnectorActionKind, ConnectorManifest } from "@arden/protocol";
import { SectionHeading, StatusDot } from "./primitives";

/**
 * Connectors context panel: connector manifests with health status, permission
 * chips, and a "use in composer" / "prepare auth" action.
 */

export function PluginPanel({
  manifests,
  onUseConnector,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelect,
  onPrepareAction
}: {
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
  onConnect: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  onSelect: (connector: ConnectorManifest) => void;
  onPrepareAction: (action: ConnectorActionKind, payload: Record<string, string>) => void;
}) {
  return (
    <section className="context-panel" aria-label="Connectors">
      <SectionHeading title="Connectors" meta="bridges and permissions" />
      <div className="connector-grid">
        {manifests.map((connector) => {
          const ready = connector.status === "connected" || connector.status === "fixture";
          const firstAction = connector.supportedActions?.[0];
          return (
            <article className="connector-card" key={connector.id} data-connector-id={connector.id}>
              <div className="connector-card__top">
                <span>
                  <strong>{connector.name}</strong>
                  <small>{connector.healthSummary}</small>
                </span>
                <StatusDot tone={ready ? "ready" : "needs-auth"} />
              </div>
              <dl className="connector-card__meta">
                <div>
                  <dt>Status</dt>
                  <dd>{connector.status}</dd>
                </div>
                <div>
                  <dt>Health</dt>
                  <dd>{connector.health?.state ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Checked</dt>
                  <dd>{connector.lastCheckedAt}</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>
                    {connector.authMode === "none"
                      ? "Local device"
                      : connector.account?.displayName ?? "Not connected"}
                  </dd>
                </div>
              </dl>
              <div className="permission-list">
                {(connector.scopes?.map((scope) => scope.label) ?? connector.permissions).map((permission) => (
                  <span key={permission}>{permission}</span>
                ))}
              </div>
              {connector.setupMessage && connector.status !== "connected" ? (
                <p className="connector-card__setup">{connector.setupMessage}</p>
              ) : null}
              <div className="connector-card__actions">
                {connector.supportsSearch ? (
                  <button type="button" onClick={() => onSelect(connector)}>
                    Search / import
                  </button>
                ) : (
                  <button type="button" onClick={() => onUseConnector(connector)}>
                    Use in composer
                  </button>
                )}
                {connector.status === "connected" && connector.authMode !== "none" ? (
                  <button type="button" onClick={() => onDisconnect(connector.id)}>
                    Disconnect
                  </button>
                ) : connector.authMode !== "none" ? (
                  <button type="button" onClick={() => onConnect(connector)}>
                    {connector.status === "fixture" ? "Live setup" : "Connect"}
                  </button>
                ) : null}
                {connector.status === "expired" ||
                connector.status === "error" ||
                connector.status === "unavailable" ? (
                  <button type="button" onClick={() => onRefresh(connector.id)}>
                    Retry
                  </button>
                ) : null}
                {firstAction ? (
                  <button
                    type="button"
                    onClick={() =>
                      onPrepareAction(firstAction, {
                        targetId: `${connector.id}-fixture-selection`
                      })
                    }
                  >
                    Prepare {actionLabel(firstAction)}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function actionLabel(action: ConnectorActionKind) {
  return action
    .split(".")
    .at(-1)!
    .replaceAll("-", " ");
}
