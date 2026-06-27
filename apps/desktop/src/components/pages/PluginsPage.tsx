import { FormEvent, useState } from "react";
import { Plugs, PuzzlePiece, Sparkle } from "@phosphor-icons/react";
import type { FirstWaveConnectorId } from "@arden/protocol";
import { PageHeader } from "../PageHeader";
import { PluginPanel } from "../PluginPanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";

/**
 * Connector status, setup, fixture search/import, and approval preparation.
 * Live auth and provider egress stay behind the Rust runtime boundary.
 */
export function PluginsPage({ runtime }: { runtime: ShellRuntime }) {
  const [selectedConnectorId, setSelectedConnectorId] =
    useState<FirstWaveConnectorId>("github");
  const [query, setQuery] = useState("");
  const searchableConnectors = runtime.connectorManifests.filter(
    (connector): connector is typeof connector & { id: FirstWaveConnectorId } =>
      connector.supportsSearch === true &&
      connector.id !== "local-files" &&
      connector.id !== "linear"
  );
  const connected = runtime.connectorManifests.filter(
    (connector) => connector.status === "connected"
  ).length;
  const fixture = runtime.connectorManifests.filter(
    (connector) => connector.status === "fixture"
  ).length;
  const connectedBackends = runtime.backendProviders.filter(
    (provider) => provider.authState === "connected"
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void runtime.searchConnector({
      connectorId: selectedConnectorId,
      query,
      limit: 20
    });
  };

  return (
    <>
      <PageHeader
        icon={PuzzlePiece}
        title="Connectors"
        description="Bridges to your tools, gated behind explicit permissions. Fixtures are preview data — no live credentials are stored."
        meta={`${connected} connected · ${fixture} fixture · ${runtime.connectorManifests.length} total`}
      />

      {connectedBackends.length > 0 ? (
        <section className="context-panel backends-panel" aria-label="Connected AI backends">
          <div className="backends-panel__heading">
            <span className="backends-panel__icon" aria-hidden="true">
              <Sparkle size={18} />
            </span>
            <div>
              <strong>Connected AI backends</strong>
              <small>
                Agent-runtime backends routed through Arden's approval system. Credentials are held
                by the local credential boundary.
              </small>
            </div>
          </div>
          <ul className="backends-list">
            {connectedBackends.map((provider) => (
              <li key={provider.id} className="backends-list__row" data-provider-id={provider.id}>
                <span className="backends-list__icon" aria-hidden="true">
                  <Plugs size={15} />
                </span>
                <span className="backends-list__lead">
                  <strong>{provider.label}</strong>
                  <small>{provider.backendType}</small>
                </span>
                <span className="backends-list__caps">
                  {providerCapabilityLabels(provider)
                    .slice(0, 4)
                    .map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <PluginPanel
        manifests={runtime.connectorManifests}
        onUseConnector={runtime.useConnector}
        onConnect={(connector) => void runtime.connectConnector(connector)}
        onDisconnect={(connectorId) => void runtime.disconnectConnector(connectorId)}
        onRefresh={(connectorId) => void runtime.refreshConnector(connectorId)}
        onSelect={(connector) => {
          if (connector.id !== "local-files" && connector.id !== "linear") {
            setSelectedConnectorId(connector.id as FirstWaveConnectorId);
          }
        }}
        onPrepareAction={(action, payload) =>
          void runtime.prepareConnectorAction(action, payload)
        }
      />

      <section className="context-panel connector-browser" aria-label="Connector search and import">
        <div className="connector-browser__heading">
          <div>
            <h2>Search and import</h2>
            <p>
              Preview selected provider content before importing it as untrusted workspace
              knowledge.
            </p>
          </div>
          <span>{runtime.connectorImportedSources.length} imported</span>
        </div>
        <form className="connector-search" onSubmit={submitSearch}>
          <label>
            <span>Connector</span>
            <select
              aria-label="Search connector"
              value={selectedConnectorId}
              onChange={(event) =>
                setSelectedConnectorId(event.currentTarget.value as FirstWaveConnectorId)
              }
            >
              {searchableConnectors.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {connector.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Query</span>
            <input
              aria-label="Connector search query"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search selected content"
            />
          </label>
          <button type="submit" aria-label="Search connector content">
            Search
          </button>
        </form>

        {runtime.connectorStatus ? (
          <p className="connector-browser__status" role="status">
            {runtime.connectorStatus}
          </p>
        ) : null}

        {runtime.connectorSearchResult ? (
          runtime.connectorSearchResult.items.length > 0 ? (
            <div className="connector-results">
              {runtime.connectorSearchResult.items.map((item) => (
                <article key={item.id} className="connector-result">
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.provenance} · {item.freshness} · {item.trust}
                    </small>
                    <p>{item.summary}</p>
                  </div>
                  <button type="button" onClick={() => void runtime.importConnectorItem(item)}>
                    Import
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">No connector items matched this search.</div>
          )
        ) : (
          <div className="empty-state">
            Choose a connector and search its explicit fixture or connected scope.
          </div>
        )}
      </section>
    </>
  );
}
