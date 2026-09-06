import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listRuntimeMcpServerConfigurations } from "../runtime";
import { RemoteConnectorDetails } from "./marketplace/RemoteConnectorDetails";
import { remoteConnectorFor, remoteConnectorServerId, remoteConnectors } from "./marketplace/remote-connectors";
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
import { connectorGuides } from "./marketplace/connector-guides";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import { MarketplaceIcon } from "./marketplace/MarketplaceIcon";
import {
  findMarketplaceConnector,
  marketplaceConnectorSections,
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
 * Marketplace directory backed by native manifests and official remote setup
 * routes. A saved endpoint never establishes a connected or installed state.
 */
export function PluginPanel({
  workspaceId,
  manifests,
  onUseConnector,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelect,
  accounts,
  onSwitchAccount,
}: {
  workspaceId?: string;
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
  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [useRemote, setUseRemote] = useState(false);
  const [savedRemoteIds, setSavedRemoteIds] = useState<string[]>([]);
  const refreshSaved = useCallback(async () => {
    if (!workspaceId) return;
    const servers = await listRuntimeMcpServerConfigurations(workspaceId).catch(() => null);
    return servers?.filter((server) => !server.disabled).map((server) => server.id) ?? [];
  }, [workspaceId]);
  useEffect(() => {
    let active = true;
    setSavedRemoteIds([]);
    if (!workspaceId) return;
    void refreshSaved().then((ids) => { if (active) setSavedRemoteIds(ids ?? []); });
    return () => { active = false; };
  }, [refreshSaved, workspaceId]);
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
  const hasDirectoryMatches = visibleSections.length > 0;

  const openEntry = (entry: MarketplaceConnectorEntry) => {
    setSelectedEntryId(entry.id);
    const connector = manifestById.get(entry.id);
    setUseRemote(Boolean(remoteConnectorFor(entry.id)) && (!connector || connector.status !== "connected" || savedRemoteIds.includes(remoteConnectorServerId(entry.id))));
    if (connector) onSelect(connector);
  };

  const renderConnectorRow = (
    entry: MarketplaceConnectorEntry,
    placement: string,
  ) => {
    const connector = manifestById.get(entry.id);
    const remote = remoteConnectorFor(entry.id);
    const connectable = Boolean(connector || remote);
    const connected = connector?.status === "connected";
    const cardDetail = connector ? resolveDetailedStatus(connector) : null;
    const needsReconnect =
      cardDetail?.className === "expired" ||
      cardDetail?.className === "revoked" ||
      cardDetail?.className === "failed";
    const ariaLabel = connected
      ? `Manage ${entry.name}`
      : connectable
        ? `${needsReconnect ? "Reconnect" : "Connect"} ${entry.name}`
        : `${entry.name} is planned`;

    return (
      <button
        type="button"
        className="marketplace-connector-row"
        key={`${placement}-${entry.id}`}
        data-connector-id={entry.id}
        data-availability={connectable ? "available" : "planned"}
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
          {!connectable ? <small>Planned</small> : null}
        </span>
        <span
          className={`marketplace-connector-row__action${connected ? " marketplace-connector-row__action--connected" : ""}`}
          aria-hidden="true"
        >
          {connected ? (
            <Check size={19} weight="bold" />
          ) : connectable ? (
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
          <p>Give your agents access to the tools you use.</p>
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
                  title={connector.name}
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

      {savedRemoteIds.length ? <section className="marketplace-section" aria-label="Saved app connections">
        <h2>Saved connections</h2><p>Open a connection to verify its account and enabled tools.</p>
        <div className="marketplace-connector-grid">{remoteConnectors.filter((preset) => savedRemoteIds.includes(remoteConnectorServerId(preset.id))).map((preset) => findMarketplaceConnector(preset.id)).filter((entry): entry is MarketplaceConnectorEntry => Boolean(entry)).filter((entry) => !normalizedQuery || `${entry.name} ${entry.description}`.toLowerCase().includes(normalizedQuery)).map((entry) => renderConnectorRow(entry, "saved"))}</div>
      </section> : null}

      {[
        ...(!normalizedQuery ? [{ id: "popular", title: "Popular", connectors: ["gmail", "github", "google-drive", "slack", "notion", "google-calendar", "linear", "vercel"].map(findMarketplaceConnector).filter((entry): entry is MarketplaceConnectorEntry => Boolean(entry)) }] : []),
        ...visibleSections,
      ].map((section) => {
        const expanded = Boolean(normalizedQuery) || expandedSections.includes(section.id);
        const limit = section.id === "popular" ? 6 : 4;
        const shown = expanded ? section.connectors : section.connectors.slice(0, limit);
        const remaining = section.connectors.slice(limit);
        return <section className="marketplace-section" aria-labelledby={`marketplace-section-${section.id}`} key={section.id}>
          <h2 id={`marketplace-section-${section.id}`}>{section.title}</h2>
          <div className="marketplace-connector-grid">{shown.map((entry) => renderConnectorRow(entry, section.id))}</div>
          {remaining.length ? <button className="marketplace-see-more" type="button" aria-expanded={expanded} onClick={() => setExpandedSections((current) => expanded ? current.filter((id) => id !== section.id) : [...current, section.id])}>
            {!expanded ? <span className="marketplace-see-more__icons" aria-hidden="true">{remaining.slice(0, 3).map((entry) => <MarketplaceIcon key={entry.id} id={entry.id} icon={entry.icon} size={17} />)}</span> : null}
            {expanded ? "Show less" : `See ${remaining.slice(0, 2).map((entry) => entry.name).join(", ")}${remaining.length > 2 ? ", and more" : ""}`}
          </button> : null}
        </section>;
      })}

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
            {(useRemote || !selectedConnector) && remoteConnectorFor(selectedEntry.id) ? (
              <RemoteConnectorDetails key={`${workspaceId}-${selectedEntry.id}`} entry={selectedEntry} preset={remoteConnectorFor(selectedEntry.id)!} workspaceId={workspaceId}
                titleId={`connector-detail-${selectedEntry.id}`} onSaved={() => setSavedRemoteIds((ids) => [...new Set([...ids, remoteConnectorServerId(selectedEntry.id)])])} />
            ) : selectedConnector ? (
              <>
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
              {remoteConnectorFor(selectedEntry.id) && selectedConnector.status !== "connected" ? <button type="button" className="button button--secondary" onClick={() => setUseRemote(true)}>Connect through {selectedEntry.name}'s official service</button> : null}
              </>
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
            agent.
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
  const guide = connectorGuides[connector.id];

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
          <p>{guide?.description ?? detail.summary}</p>
        </div>
        <span
          className={`connector-detail__status connector-detail__status--${detail.className}`}
        >
          {detail.label}
        </span>
      </div>

      {guide ? <section className="connector-guide" aria-label="How to use this connector">
        <h3>Try asking</h3>
        <div className="connector-guide__examples">{guide.examples.map((example) => <p key={example}>{example}</p>)}</div>
        <h3>How it works</h3>
        <ol><li>Connect your account and choose the access you want to grant.</li><li>The connection is available to every agent in your workspace.</li><li>Mention <code>@{connector.id}</code> in a message, or choose it from the attachment menu.</li></ol>
        <p>Fable uses the access you grant. Changes follow your workspace's approval settings.</p>
      </section> : null}
      <div className="connector-detail__body">
        {connector.status !== "connected" ? <div><span>Connection setup</span><p>{detail.summary}</p></div> : null}
        <div>
          <span>Access</span>
          {permissions.length ? <ul>
            {permissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul> : <p>Access is shown when you connect.</p>}
        </div>
        {connector.status === "connected" ? <>
        <div>
          <span>Connection</span>
          <p>{detail.summary}</p>
        </div>
        <div>
          <span>Sync</span>
          <p>{syncLabel(connector)}</p>
        </div>
        </> : null}
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
          <button type="button" disabled={detail.className === "failed" || detail.className === "permission-limited"} onClick={() => onUseConnector(connector)}>
            Use in composer
          </button>
        ) : null}
        {connector.status !== "connected" && connector.authMode !== "none" ? (
          <button
            type="button"
            className="button button--primary"
            disabled={detail.className === "configuration-required" || detail.className === "unavailable"}
            onClick={() => onConnect(connector)}
          >
            {detail.className === "configuration-required" ? "Setup needed" : detail.className === "unavailable" ? "Unavailable" : detail.className === "expired" ||
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
      label: "Needs permission",
      className: "permission-limited",
      summary: `${connector.name} is missing required scopes or permissions.`,
    };
  }

  if (status === "connected" && (healthState === "error" || healthState === "degraded")) {
    return { label: "Connection issue", className: "failed", summary: healthSummary || "Check this connection and try again." };
  }

  // Only an active sync operation establishes that syncing is happening.
  if (status === "connected" && connector.sync?.phase === "syncing") {
    return {
      label: "Syncing",
      className: "syncing",
      summary: `Syncing ${connector.name}…`,
    };
  }
  if (status === "connected" && healthState === "unknown") {
    return { label: "Not checked", className: "unverified", summary: healthSummary || "Connection health has not been checked yet." };
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
      label: "Setup needed",
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
    label: "Not connected",
    className: "needs-auth",
    summary:
      setupMessage ??
      healthSummary ??
      `Connect your ${connector.name} account.`,
  };
}
