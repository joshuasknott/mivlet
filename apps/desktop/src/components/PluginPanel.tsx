import { PluginOverview } from "./marketplace/PluginOverview";
import { TokenPluginDetails } from "./marketplace/TokenPluginDetails";
import { tokenPluginFor } from "@fable/connectors/providers/token-plugins";
import { useMemo, useRef, useState } from "react";
import { BuiltinPlugins } from "./marketplace/BuiltinPlugins";
import { builtinPluginEntries } from "../lib/builtin-plugins";
import { RemoteConnectorDetails } from "./marketplace/RemoteConnectorDetails";
import { remoteConnectorFor } from "./marketplace/remote-connectors";
import { connectorConnectionsChanged } from "../lib/connector-connections";
import { connectorErrorMessage } from "../lib/connector-errors";
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
  initialConnectorId,
  workspaceId,
  manifests,
  onUseConnector,
  onUseBuiltinPlugin,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelect,
  accounts,
  onSwitchAccount,
}: {
  initialConnectorId?: string;
  workspaceId?: string;
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest, prompt?: string) => void;
  onUseBuiltinPlugin?: (id: "browser" | "computer") => void;
  onConnect: (connector: ConnectorManifest) => void | Promise<void>;
  onDisconnect: (connectorId: string) => void | Promise<void>;
  onRefresh: (connectorId: string) => void;
  onSelect: (connector: ConnectorManifest) => void;
  accounts: Record<string, ConnectorAccountOption[]>;
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [readiness, setReadiness] = useState<"available" | "connected" | "attention" | "planned">("available");
  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(initialConnectorId ?? null);
  const [useRemote, setUseRemote] = useState(() => {
    const connector = manifests.find((candidate) => candidate.id === initialConnectorId);
    return Boolean(initialConnectorId && remoteConnectorFor(initialConnectorId)) && (connector?.connectionRoute === "remote" || (!connector?.account && (!connector || ["configured", "unconfigured", "needs-auth"].includes(connector.status))));
  });
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
  const matchesReadiness = (entry: MarketplaceConnectorEntry) => {
    const connector = manifestById.get(entry.id);
    const usable = Boolean(connector || remoteConnectorFor(entry.id) || tokenPluginFor(entry.id));
    if (readiness === "planned") return !usable;
    if (readiness === "connected") return connector?.status === "connected" && ["connected", "syncing"].includes(resolveDetailedStatus(connector).className);
    if (readiness === "attention") return !!connector && ["expired", "revoked", "failed", "unavailable", "permission-limited", "unverified", "configuration-required", "needs-auth"].includes(resolveDetailedStatus(connector).className);
    return usable;
  };
  const showBuiltins = readiness === "available" && builtinPluginEntries.some((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(normalizedQuery));
  const visibleSections = useMemo(() => {
    return marketplaceConnectorSections
      .map((section) => ({
        ...section,
        connectors: section.connectors.filter((entry) => {
          if (!matchesReadiness(entry)) return false;
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
  }, [manifestById, normalizedQuery, readiness]);
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
  const hasDirectoryMatches = visibleSections.length > 0 || showBuiltins;

  const openEntry = (entry: MarketplaceConnectorEntry) => {
    setSelectedEntryId(entry.id);
    const connector = manifestById.get(entry.id);
    const remote = Boolean(remoteConnectorFor(entry.id)) && (connector?.connectionRoute === "remote" || (!connector?.account && (!connector || ["configured", "unconfigured", "needs-auth"].includes(connector.status))));
    setUseRemote(remote);
    if (connector && !remote) onSelect(connector);
  };

  const renderConnectorRow = (
    entry: MarketplaceConnectorEntry,
    placement: string,
  ) => {
    const connector = manifestById.get(entry.id);
    const remote = remoteConnectorFor(entry.id);
    const connectable = Boolean(connector || remote || tokenPluginFor(entry.id));
    const cardDetail = connector ? resolveDetailedStatus(connector) : null;
    const connected = connector?.status === "connected" && !!cardDetail && ["connected", "syncing"].includes(cardDetail.className);
    const needsReconnect =
      cardDetail?.className === "expired" ||
      cardDetail?.className === "revoked" ||
      cardDetail?.className === "failed" ||
      cardDetail?.className === "permission-limited";
    const ariaLabel = needsReconnect
      ? `Reconnect ${entry.name}`
      : connector?.status === "connected" ? `Manage ${entry.name}`
      : connectable
        ? `Connect ${entry.name}`
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
    <section className="connectors-marketplace" aria-label="Plugins">
      <header className="marketplace-page-header">
        <div>
          <h1>Plugins</h1>
          <p>Give your agents access to the tools you use.</p>
        </div>
        <label className="connections-search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <span className="sr-only">Search plugins</span>
          <input
            type="search"
            placeholder="Search plugins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      <div className="marketplace-readiness" role="group" aria-label="Filter plugins by readiness">{([ ["available", "Available"], ["connected", "Connected"], ["attention", "Needs attention"], ["planned", "Planned"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={readiness === value} onClick={() => setReadiness(value)}>{label}</button>)}</div>
      {readiness === "planned" ? <p className="marketplace-section__empty">Planned integrations are not available to connect yet.</p> : null}
      {readiness === "available" ? <section
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
              ? "No installed plugins match this search."
              : "Connect an app and it will appear here."}
          </p>
        )}
      </section> : null}

      {[
        ...(showBuiltins ? [{ id: "featured", title: "Featured", connectors: normalizedQuery ? [] : ["gmail", "github", "google-drive", "slack", "notion", "google-calendar", "linear", "vercel"].map(findMarketplaceConnector).filter((entry): entry is MarketplaceConnectorEntry => Boolean(entry)).filter(matchesReadiness) }] : []),
        ...visibleSections,
      ].map((section) => {
        const expanded = Boolean(normalizedQuery) || expandedSections.includes(section.id);
        const limit = section.id === "featured" ? 6 : 4;
        const shown = expanded ? section.connectors : section.connectors.slice(0, limit);
        const remaining = section.connectors.slice(limit);
        return <section className="marketplace-section" aria-labelledby={`marketplace-section-${section.id}`} key={section.id}>
          <h2 id={`marketplace-section-${section.id}`}>{section.title}</h2>
          {section.id === "featured" ? <BuiltinPlugins workspaceId={workspaceId} query={query} onUse={onUseBuiltinPlugin} /> : null}
          <div className="marketplace-connector-grid">{shown.map((entry) => renderConnectorRow(entry, section.id))}</div>
          {remaining.length ? <button className="marketplace-see-more" type="button" aria-expanded={expanded} onClick={() => setExpandedSections((current) => expanded ? current.filter((id) => id !== section.id) : [...current, section.id])}>
            {!expanded ? <span className="marketplace-see-more__icons" aria-hidden="true">{remaining.slice(0, 3).map((entry) => <MarketplaceIcon key={entry.id} id={entry.id} icon={entry.icon} size={17} />)}</span> : null}
            {expanded ? "Show less" : `See ${remaining.slice(0, 2).map((entry) => entry.name).join(", ")}${remaining.length > 2 ? ", and more" : ""}`}
          </button> : null}
        </section>;
      })}

      {!hasDirectoryMatches ? (
        <p className="marketplace-search-empty" role="status">
          {query.trim() ? `No plugins match “${query.trim()}” in this filter.` : "No plugins in this filter."}
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
              aria-label="Close plugin setup"
              onClick={() => setSelectedEntryId(null)}
            >
              <X size={17} />
            </button>
            {tokenPluginFor(selectedEntry.id) ? (
              <TokenPluginDetails key={`${workspaceId}-${selectedEntry.id}`} plugin={tokenPluginFor(selectedEntry.id)!} connector={selectedConnector} workspaceId={workspaceId} onUseConnector={onUseConnector} onDisconnect={onDisconnect} accounts={accounts[selectedEntry.id]} onSwitchAccount={onSwitchAccount} titleId={`connector-detail-${selectedEntry.id}`} />
            ) : (useRemote || !selectedConnector) && remoteConnectorFor(selectedEntry.id) ? (
              <RemoteConnectorDetails key={`${workspaceId}-${selectedEntry.id}`} entry={selectedEntry} preset={remoteConnectorFor(selectedEntry.id)!} workspaceId={workspaceId}
                titleId={`connector-detail-${selectedEntry.id}`} onUseConnector={onUseConnector} onSaved={() => { if (workspaceId) connectorConnectionsChanged(workspaceId); }} />
            ) : selectedConnector ? (
              <>
              <ConnectorDetails
                key={selectedConnector.id}
                connector={selectedConnector}
                onUseConnector={onUseConnector}
                onDisconnect={onDisconnect}
                onRefresh={onRefresh}
                accounts={accounts[selectedConnector.id] ?? []}
                onSwitchAccount={onSwitchAccount}
                onConnect={onConnect}
                titleId={`connector-detail-${selectedConnector.id}`}
              />
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
      <p className="connector-detail__eyebrow">Plugins</p>
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
            Mivlet does not have a native adapter or authorization path for this
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
  connector, onUseConnector, onDisconnect, onRefresh, accounts, onSwitchAccount, onConnect, titleId,
}: {
  connector: ConnectorManifest;
  onUseConnector: (connector: ConnectorManifest, prompt?: string) => void;
  onDisconnect: (connectorId: string) => void | Promise<void>;
  onRefresh: (connectorId: string) => void;
  accounts: ConnectorAccountOption[];
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
  onConnect: (connector: ConnectorManifest) => void | Promise<void>;
  titleId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const operation = useRef(false);
  const detail = resolveDetailedStatus(connector);
  const connected = connector.status === "connected";
  const needsRepair = ["failed", "permission-limited", "expired", "revoked", "unverified"].includes(detail.className);
  const ready = connected && !needsRepair;
  const configured = !["configuration-required", "unavailable"].includes(detail.className);
  const run = async (task: () => void | Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setNotice("");
    try { await task(); }
    catch (error) { setNotice(connectorErrorMessage(error)); }
    finally { operation.current = false; setBusy(false); }
  };
  const granted = connector.scopes?.filter((scope) => scope.granted) ?? [];

  return <article className="connector-detail" aria-label={`${connector.name} details`} aria-busy={busy}>
    <p className="connector-detail__eyebrow">Plugins</p>
    <div className="connector-detail__header">
      <span className={`connector-card__logo-container connector-card__logo-container--${connector.id}`}><ConnectorIcon id={connector.id} /></span>
      <div><h2 id={titleId}>{connector.name}</h2><p>{findMarketplaceConnector(connector.id)?.description ?? connector.name}</p></div>
      <span className={`connector-detail__status connector-detail__status--${detail.className}`}>{busy ? "Connecting…" : ready ? "Connected" : connected ? "Reconnect" : detail.label}</span>
    </div>

    {connector.account ? <p className="connector-detail__account">Active connection: {connector.account.email ?? connector.account.displayName}</p> : null}
    {connected && accounts.length > 1 ? <label className="connector-detail__account">
      <span>Account</span>
      <select aria-label="Active connection" disabled={busy} value={accounts.find((option) => option.active)?.connectionId ?? ""}
        onChange={(event) => onSwitchAccount(connector.id, event.target.value)}>
        {accounts.map(({ account, connectionId }) => <option key={connectionId} value={connectionId}>{account.email ?? account.displayName}</option>)}
      </select>
    </label> : null}
    <p className="connector-detail__intro">{ready ? "Ready to use with any of your agents." : configured ? `Sign in to use ${connector.name} in your conversations.` : "This connection is not available on this installation yet."}</p>
    <div className="connector-detail__actions">
      {ready ? <button type="button" disabled={busy} onClick={() => onUseConnector(connector)}>Use in chat</button> :
        <button type="button" className="button--primary" disabled={busy || !configured} onClick={() => void run(() => onConnect(connector))}>
          {busy ? "Connecting…" : configured ? needsRepair ? "Reconnect" : "Connect" : "Unavailable"}
        </button>}
      {connected || connector.account ? <button type="button" disabled={busy} onClick={() => void run(() => onDisconnect(connector.id))}>Disconnect</button> : null}
    </div>
    {notice ? <p className="connector-detail__notice" role="alert">{notice}</p> : null}
    {!ready && detail.summary ? <p className="connector-detail__notice" role="status">{detail.summary}</p> : null}
    <PluginOverview id={connector.id} access={ready ? connectorAccessSummary(connector) : "Chosen when you connect"} onExample={ready && !busy ? (prompt) => onUseConnector(connector, prompt) : undefined} />
    <p className="connector-detail__hint">{ready ? connectorAccessSummary(connector) : "Choose your account and grant access on the sign-in page."} Actions follow your workspace approval preference.</p>
    <details className="connector-guide">
      <summary>About this connection</summary>
      {granted.length ? <><p>Access granted</p><ul>{granted.map((scope) => <li key={scope.id}>{scope.label}</li>)}</ul></> : null}
      {connected ? <button type="button" className="connector-detail__text-action" disabled={busy || connector.sync?.phase === "syncing"} onClick={() => onRefresh(connector.id)}>Sync files</button> : null}
    </details>
  </article>;
}

export function connectorAccessSummary(connector: ConnectorManifest): string {
  const granted = new Set(connector.scopes?.filter((scope) => scope.granted).map((scope) => scope.id));
  if (connector.id === "google-drive") {
    if (granted.has("https://www.googleapis.com/auth/drive")) return "Read and update your Drive files.";
    if (granted.has("https://www.googleapis.com/auth/drive.readonly")) return granted.has("https://www.googleapis.com/auth/drive.file") ? "Read your Drive files. Updates are limited to files shared with Mivlet." : "Read your Drive files.";
    return "Access files shared with Mivlet.";
  }
  if (connector.id === "gmail") return granted.has("https://www.googleapis.com/auth/gmail.send") ? "Read email and prepare or send messages." : "Read your email.";
  if (connector.id === "google-calendar") return granted.has("https://www.googleapis.com/auth/calendar.events") ? "Read calendars and manage events." : "Read calendars and events.";
  return "Uses the access you granted when connecting.";
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
        : `${connector.name} is not configured on the Mivlet auth broker.`;
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
