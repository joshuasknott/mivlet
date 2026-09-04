import { useMemo, useRef, useState } from "react";
import type {
  ConnectorAccountOption,
  ConnectorManifest,
} from "@fable/protocol";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ConnectorIcon } from "./ConnectorIcon";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import { MarketplaceIcon } from "./marketplace/MarketplaceIcon";
import {
  findMarketplaceConnector,
  marketplaceConnectorSections,
  recommendedMarketplaceConnectors,
  type MarketplaceConnectorEntry,
} from "./marketplace/marketplace-catalog";

const INSTALLED_CONNECTOR_PRIORITY = [
  "gmail",
  "google-drive",
  "slack",
  "github",
  "google-calendar",
  "notion",
  "linear",
  "vercel",
];

/**
 * Marketplace directory backed by the native connector manifests. Catalogue
 * rows without a matching manifest are visible as Planned but can never enter
 * a connected or installed state.
 */
export function PluginPanel({
  manifests,
  onUseConnector,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelect,
  accounts,
  onSwitchAccount,
}: {
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
  onConnect: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  onSelect: (connector: ConnectorManifest) => void;
  accounts: Record<string, ConnectorAccountOption[]>;
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const detailModalRef = useRef<HTMLDivElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const manifestById = useMemo(
    () => new Map(manifests.map((connector) => [connector.id, connector])),
    [manifests],
  );
  const selectedEntry = useMemo(
    () =>
      (selectedEntryId ? findMarketplaceConnector(selectedEntryId) : null) ??
      null,
    [selectedEntryId],
  );
  const selectedConnector = useMemo(
    () =>
      (selectedEntryId ? manifestById.get(selectedEntryId) : undefined) ?? null,
    [manifestById, selectedEntryId],
  );

  useModalFocusTrap({
    active: selectedEntry !== null,
    containerRef: detailModalRef,
    initialFocusRef: detailCloseRef,
    onClose: () => setSelectedEntryId(null),
  });

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSections = useMemo(() => {
    if (!normalizedQuery) return marketplaceConnectorSections;
    return marketplaceConnectorSections
      .map((section) => ({
        ...section,
        connectors: section.connectors.filter((entry) => {
          const manifest = manifestById.get(entry.id);
          return [
            entry.name,
            entry.description,
            section.title,
            manifest?.setupMessage,
            manifest?.healthSummary,
            ...(manifest?.permissions ?? []),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        }),
      }))
      .filter((section) => section.connectors.length > 0);
  }, [manifestById, normalizedQuery]);
  const installedManifests = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return manifests
      .filter(
        (connector) =>
          connector.status === "connected" &&
          connector.id !== "local-files" &&
          (!normalized ||
            [
              connector.name,
              connector.setupMessage,
              connector.healthSummary,
              ...connector.permissions,
            ]
              .filter(Boolean)
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalized)),
      )
      .sort((left, right) => {
        const leftIndex = INSTALLED_CONNECTOR_PRIORITY.indexOf(left.id);
        const rightIndex = INSTALLED_CONNECTOR_PRIORITY.indexOf(right.id);
        return (
          (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
          (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
        );
      });
  }, [manifests, query]);
  const visibleRecommended = recommendedMarketplaceConnectors.filter((entry) =>
    visibleSections.some((section) =>
      section.connectors.some((candidate) => candidate.id === entry.id),
    ),
  );
  const hasDirectoryMatches = visibleSections.length > 0;

  const openEntry = (entry: MarketplaceConnectorEntry) => {
    setSelectedEntryId(entry.id);
    const connector = manifestById.get(entry.id);
    if (connector) onSelect(connector);
  };

  const renderConnectorRow = (
    entry: MarketplaceConnectorEntry,
    placement: string,
  ) => {
    const connector = manifestById.get(entry.id);
    const connected = connector?.status === "connected";
    const cardDetail = connector ? resolveDetailedStatus(connector) : null;
    const needsReconnect =
      cardDetail?.className === "expired" ||
      cardDetail?.className === "revoked" ||
      cardDetail?.className === "failed";
    const ariaLabel = connected
      ? `Manage ${entry.name}`
      : connector
        ? `${needsReconnect ? "Reconnect" : "Connect"} ${entry.name}`
        : `${entry.name} is planned`;

    return (
      <button
        type="button"
        className="marketplace-connector-row"
        key={`${placement}-${entry.id}`}
        data-connector-id={entry.id}
        data-availability={connector ? "available" : "planned"}
        onClick={() => openEntry(entry)}
        aria-label={ariaLabel}
      >
        <span
          className={`marketplace-connector-icon marketplace-connector-icon--${entry.icon}`}
          aria-hidden="true"
        >
          <MarketplaceIcon id={entry.id} icon={entry.icon} />
        </span>
        <span className="marketplace-connector-row__copy">
          <strong>{entry.name}</strong>
          <span>{entry.description}</span>
        </span>
        <span
          className={`marketplace-connector-row__action${connected ? " marketplace-connector-row__action--connected" : ""}`}
          aria-hidden="true"
        >
          {connected ? (
            <Check size={19} weight="bold" />
          ) : connector ? (
            <Plus size={19} />
          ) : (
            <Clock size={17} />
          )}
        </span>
      </button>
    );
  };

  return (
    <section className="connectors-marketplace" aria-label="Connectors">
      <header className="marketplace-page-header">
        <div>
          <h1>Connectors</h1>
          <p>Give your teammates access to the tools you use.</p>
        </div>
        <label className="connections-search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <span className="sr-only">Search connectors</span>
          <input
            type="search"
            placeholder="Search connectors"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>

      <section
        className="marketplace-section marketplace-section--installed"
        aria-labelledby="installed-connections-title"
      >
        <h2 id="installed-connections-title">Installed</h2>
        {installedManifests.length ? (
          <div className="marketplace-installed-list">
            {installedManifests.map((connector) => {
              const entry = findMarketplaceConnector(connector.id);
              if (!entry) return null;
              return (
                <button
                  type="button"
                  className="marketplace-installed-connector"
                  key={connector.id}
                  onClick={() => openEntry(entry)}
                  aria-label={`Manage ${connector.name} from Installed`}
                >
                  <span
                    className={`marketplace-installed-connector__icon marketplace-connector-icon--${entry.icon}`}
                    aria-hidden="true"
                  >
                    <MarketplaceIcon
                      id={entry.id}
                      icon={entry.icon}
                      size={30}
                    />
                  </span>
                  <span>
                    {connector.name}
                    <i aria-hidden="true" />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="marketplace-section__empty">
            {query.trim()
              ? "No installed connectors match this search."
              : "Connect an app and it will appear here."}
          </p>
        )}
      </section>

      {visibleRecommended.length ? (
        <section
          className="marketplace-section"
          aria-labelledby="recommended-connections-title"
        >
          <h2 id="recommended-connections-title">Recommended</h2>
          <div className="marketplace-connector-grid">
            {visibleRecommended.map((entry) =>
              renderConnectorRow(entry, "recommended"),
            )}
          </div>
        </section>
      ) : null}

      {visibleSections.map((section) => (
        <section
          className="marketplace-section"
          aria-labelledby={`marketplace-section-${section.id}`}
          key={section.id}
        >
          <h2 id={`marketplace-section-${section.id}`}>{section.title}</h2>
          <div className="marketplace-connector-grid">
            {section.connectors.map((entry) =>
              renderConnectorRow(entry, section.id),
            )}
          </div>
        </section>
      ))}

      {!hasDirectoryMatches ? (
        <p className="marketplace-search-empty" role="status">
          No connectors match “{query.trim()}”.
        </p>
      ) : null}

      {selectedEntry ? (
        <div
          ref={detailModalRef}
          className="connector-detail-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`connector-detail-${selectedEntry.id}`}
          tabIndex={-1}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedEntryId(null);
            }
          }}
        >
          <div
            className="connector-detail-modal__panel"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              ref={detailCloseRef}
              type="button"
              className="connector-detail-modal__close"
              aria-label="Close connector setup"
              onClick={() => setSelectedEntryId(null)}
            >
              <X size={17} />
            </button>
            {selectedConnector ? (
              <ConnectorDetails
                connector={selectedConnector}
                onUseConnector={onUseConnector}
                onDisconnect={onDisconnect}
                onRefresh={onRefresh}
                accounts={accounts[selectedConnector.id] ?? []}
                onSwitchAccount={onSwitchAccount}
                onConnect={onConnect}
                titleId={`connector-detail-${selectedConnector.id}`}
              />
            ) : (
              <PlannedConnectorDetails
                entry={selectedEntry}
                titleId={`connector-detail-${selectedEntry.id}`}
              />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PlannedConnectorDetails({
  entry,
  titleId,
}: {
  entry: MarketplaceConnectorEntry;
  titleId: string;
}) {
  return (
    <article className="connector-detail connector-detail--planned">
      <div className="connector-detail__header">
        <span
          className={`marketplace-connector-icon marketplace-connector-icon--${entry.icon}`}
          aria-hidden="true"
        >
          <MarketplaceIcon id={entry.id} icon={entry.icon} />
        </span>
        <div>
          <h2 id={titleId}>{entry.name}</h2>
          <p>{entry.description}</p>
        </div>
        <span className="connector-detail__status connector-detail__status--planned">
          Planned
        </span>
      </div>
      <div className="connector-detail__body connector-detail__body--single">
        <div>
          <span>Availability</span>
          <p>
            Fable does not have a native adapter or authorization path for this
            connector yet. It cannot be installed, connected, or used by a
            teammate.
          </p>
        </div>
      </div>
      <div className="connector-detail__actions">
        <button type="button" disabled>
          Not available yet
        </button>
      </div>
    </article>
  );
}

function ConnectorDetails({
  connector,
  onUseConnector,
  onDisconnect,
  onRefresh,
  accounts,
  onSwitchAccount,
  onConnect,
  titleId,
}: {
  connector: ConnectorManifest;
  onUseConnector: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  accounts: ConnectorAccountOption[];
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
  onConnect: (connector: ConnectorManifest) => void;
  titleId?: string;
}) {
  const permissions =
    connector.scopes?.map((scope) => scope.label) ?? connector.permissions;
  const detail = resolveDetailedStatus(connector);

  return (
    <article
      className="connector-detail"
      aria-label={`${connector.name} details`}
    >
      <div className="connector-detail__header">
        <span
          className={`connector-card__logo-container connector-card__logo-container--${connector.id}`}
        >
          <ConnectorIcon id={connector.id} />
        </span>
        <div>
          <h2 id={titleId}>{connector.name}</h2>
          <p>{connector.setupMessage ?? detail.summary}</p>
        </div>
        <span
          className={`connector-detail__status connector-detail__status--${detail.className}`}
        >
          {detail.label}
        </span>
      </div>

      <div className="connector-detail__body">
        <div>
          <span>Access</span>
          <ul>
            {permissions.slice(0, 3).map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
        </div>
        <div>
          <span>Health</span>
          <p>{detail.summary}</p>
        </div>
        <div>
          <span>Sync</span>
          <p>{syncLabel(connector)}</p>
        </div>
      </div>

      {connector.status === "connected" && accounts.length > 1 ? (
        <label className="connector-detail__account">
          <span>Active connection</span>
          <select
            value={accounts.find((option) => option.active)?.connectionId ?? ""}
            onChange={(event) =>
              onSwitchAccount(connector.id, event.target.value)
            }
          >
            {accounts.map(({ account, connectionId }) => (
              <option key={connectionId} value={connectionId}>
                {account.email ?? account.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : connector.status === "connected" && connector.account ? (
        <p className="connector-detail__account">
          Active connection:{" "}
          {connector.account.email ?? connector.account.displayName}
        </p>
      ) : null}

      <div className="connector-detail__actions">
        {connector.status === "connected" ? (
          <button type="button" onClick={() => onUseConnector(connector)}>
            Use in composer
          </button>
        ) : null}
        {connector.status !== "connected" && connector.authMode !== "none" ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => onConnect(connector)}
          >
            {detail.className === "expired" ||
            detail.className === "revoked" ||
            detail.className === "failed"
              ? "Reconnect"
              : "Connect"}
          </button>
        ) : null}
        {connector.status === "connected" ? (
          <button
            type="button"
            disabled={connector.sync?.phase === "syncing"}
            onClick={() => onRefresh(connector.id)}
          >
            {connector.sync?.phase === "syncing" ? "Syncing…" : "Sync now"}
          </button>
        ) : null}
        {connector.status === "connected" && connector.authMode !== "none" ? (
          <button type="button" onClick={() => onDisconnect(connector.id)}>
            Disconnect
          </button>
        ) : null}
      </div>
    </article>
  );
}

function syncLabel(connector: ConnectorManifest) {
  const sync = connector.sync;
  if (!sync || sync.phase === "idle") return "Not synced";
  if (sync.phase === "succeeded")
    return `Last synced ${sync.completedAt ?? "recently"}`;
  if (sync.phase === "partial")
    return `Partial: ${sync.failure?.message ?? "some items were skipped"}`;
  if (sync.phase === "failed") return sync.failure?.message ?? "Sync failed";
  if (sync.phase === "cancelled") return "Cancelled";
  return "Syncing";
}

export function resolveDetailedStatus(connector: ConnectorManifest): {
  label: string;
  className: string;
  summary: string;
} {
  const status = connector.status;
  const healthState = connector.health?.state;
  const healthSummary = connector.health?.summary ?? connector.healthSummary;
  const setupMessage = connector.setupMessage;

  // 1. Permission Limited (missing required scopes)
  const hasMissingRequiredScopes =
    connector.scopes?.some((scope) => scope.required && !scope.granted) ??
    false;
  const isStale =
    healthSummary.toLowerCase().includes("missing required") ||
    healthSummary.toLowerCase().includes("stale");
  if (status === "connected" && (hasMissingRequiredScopes || isStale)) {
    return {
      label: "Permission Limited",
      className: "permission-limited",
      summary: `${connector.name} is missing required scopes or permissions.`,
    };
  }

  // 2. Syncing
  if (status === "connected" && healthState === "unknown") {
    return {
      label: "Syncing",
      className: "syncing",
      summary: `Verifying connection with ${connector.name}...`,
    };
  }

  // 3. Connected
  if (status === "connected") {
    let summary = healthSummary;
    if (healthState === "healthy" || !healthState) {
      const name = connector.account?.displayName ?? connector.account?.email;
      const accountInfo = name ? ` as ${name}` : "";
      summary = `${connector.name} account connected${accountInfo}.`;
    }
    return {
      label: "Connected",
      className: "connected",
      summary,
    };
  }

  // 4. Expired
  if (status === "expired" || healthSummary.toLowerCase().includes("expired")) {
    return {
      label: "Expired",
      className: "expired",
      summary: `${connector.name} authorization expired; reconnect or refresh is required.`,
    };
  }

  // 5. Revoked
  if (
    status === "revoked" ||
    healthSummary.toLowerCase().includes("revoked") ||
    healthSummary.toLowerCase().includes("disconnected")
  ) {
    return {
      label: "Revoked",
      className: "revoked",
      summary: `${connector.name} was disconnected or revoked.`,
    };
  }

  // 6. Configuration Required / Unconfigured
  const isUnconfigured =
    status === "unconfigured" ||
    status === "unavailable" ||
    status === "needs-auth";
  const hasConfigMsg =
    setupMessage?.toLowerCase().includes("broker") ||
    setupMessage?.toLowerCase().includes("config") ||
    setupMessage?.toLowerCase().includes("client_id") ||
    healthSummary.toLowerCase().includes("configuration");

  if (status === "unconfigured" || (isUnconfigured && hasConfigMsg)) {
    const summary =
      connector.authMode === "oauth-pkce"
        ? (setupMessage ??
          `${connector.name} requires a desktop OAuth client configuration.`)
        : `${connector.name} is not configured on the Fable auth broker.`;
    return {
      label: "Configuration Required",
      className: "configuration-required",
      summary,
    };
  }

  // 7. Unavailable
  if (status === "unavailable") {
    return {
      label: "Unavailable",
      className: "unavailable",
      summary: `${connector.name} service is temporarily unavailable.`,
    };
  }

  // 8. Failed
  if (
    status === "provider-error" ||
    status === "error" ||
    healthState === "error" ||
    healthState === "degraded"
  ) {
    return {
      label: "Failed",
      className: "failed",
      summary: healthSummary || `Connection to ${connector.name} failed.`,
    };
  }

  if (status === "configured") {
    return {
      label: "Ready",
      className: "configured",
      summary: setupMessage ?? healthSummary,
    };
  }

  // Default: unconfigured / Needs Authorization
  return {
    label: "Needs Authorization",
    className: "needs-auth",
    summary:
      setupMessage ??
      healthSummary ??
      `Connect your ${connector.name} account.`,
  };
}
