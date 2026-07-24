import { useMemo, useRef, useState } from "react";
import type {
  ConnectorAccountOption,
  ConnectorActionKind,
  ConnectorManifest
} from "@fable/protocol";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ConnectorIcon } from "./ConnectorIcon";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

/**
 * Icon-first connector cards with one expanded detail panel. Keep the cards
 * quiet; advanced permissions and actions only appear after selection.
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
  onPrepareAction
}: {
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
  onConnect: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  onSelect: (connector: ConnectorManifest) => void;
  accounts: Record<string, ConnectorAccountOption[]>;
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
  onPrepareAction: (action: ConnectorActionKind, payload: Record<string, string>) => void;
}) {
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(
    null
  );
  const detailModalRef = useRef<HTMLDivElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const selectedConnector = useMemo(
    () => manifests.find((connector) => connector.id === selectedConnectorId) ?? null,
    [manifests, selectedConnectorId]
  );

  useModalFocusTrap({
    active: selectedConnector !== null,
    containerRef: detailModalRef,
    initialFocusRef: detailCloseRef,
    onClose: () => setSelectedConnectorId(null)
  });

  return (
    <section className="context-panel connectors-panel" aria-label="Connectors">
      <div className="connector-grid">
        {manifests.map((connector) => {
          const connected = connector.status === "connected";
          const selected = selectedConnector?.id === connector.id;
          const cardDetail = resolveDetailedStatus(connector);
          const needsReconnect = cardDetail.className === "expired" || cardDetail.className === "revoked" || cardDetail.className === "failed";

          return (
            <article
              className="connector-card"
              key={connector.id}
              data-connector-id={connector.id}
              data-selected={selected}
              role="button"
              aria-label={
                connected
                  ? `Manage ${connector.name}`
                  : connector.authMode !== "none"
                    ? `${needsReconnect ? "Reconnect" : "Connect"} ${connector.name}`
                    : `Open ${connector.name}`
              }
              tabIndex={0}
              onClick={() => {
                setSelectedConnectorId(connector.id);
                onSelect(connector);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedConnectorId(connector.id);
                  onSelect(connector);
                }
              }}
            >
              <span className="sr-only">{connector.status}</span>
              <span className={`connector-card__logo-container connector-card__logo-container--${connector.id}`}>
                <ConnectorIcon id={connector.id} />
              </span>
              <strong>{connector.name}</strong>

              {connected ? (
                <span className="connector-card__connected">
                  <span aria-hidden="true" />
                  Connected
                </span>
              ) : connector.authMode !== "none" ? (
                <span className="connector-card__connect">
                  {needsReconnect ? "Reconnect" : "Connect"}
                </span>
              ) : (
                <span className="connector-card__connected">Available</span>
              )}
            </article>
          );
        })}
      </div>

      {selectedConnector ? (
        <div
          ref={detailModalRef}
          className="connector-detail-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`connector-detail-${selectedConnector.id}`}
          tabIndex={-1}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedConnectorId(null);
            }
          }}
        >
          <div className="connector-detail-modal__panel" onMouseDown={(event) => event.stopPropagation()}>
            <button
              ref={detailCloseRef}
              type="button"
              className="connector-detail-modal__close"
              aria-label="Close connector setup"
              onClick={() => setSelectedConnectorId(null)}
            >
              <X size={17} />
            </button>
            <ConnectorDetails
              connector={selectedConnector}
              onUseConnector={onUseConnector}
              onDisconnect={onDisconnect}
              onRefresh={onRefresh}
              accounts={accounts[selectedConnector.id] ?? []}
              onSwitchAccount={onSwitchAccount}
              onPrepareAction={onPrepareAction}
              onConnect={onConnect}
              titleId={`connector-detail-${selectedConnector.id}`}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ConnectorDetails({
  connector,
  onUseConnector,
  onDisconnect,
  onRefresh,
  accounts,
  onSwitchAccount,
  onPrepareAction,
  onConnect,
  titleId
}: {
  connector: ConnectorManifest;
  onUseConnector: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  accounts: ConnectorAccountOption[];
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
  onPrepareAction: (action: ConnectorActionKind, payload: Record<string, string>) => void;
  onConnect: (connector: ConnectorManifest) => void;
  titleId?: string;
}) {
  const firstAction = connector.supportedActions?.[0];
  const permissions = connector.scopes?.map((scope) => scope.label) ?? connector.permissions;
  const detail = resolveDetailedStatus(connector);

  return (
    <article className="connector-detail" aria-label={`${connector.name} details`}>
      <div className="connector-detail__header">
        <span className={`connector-card__logo-container connector-card__logo-container--${connector.id}`}>
          <ConnectorIcon id={connector.id} />
        </span>
        <div>
          <h2 id={titleId}>{connector.name}</h2>
          <p>{connector.setupMessage ?? detail.summary}</p>
        </div>
        <span className={`connector-detail__status connector-detail__status--${detail.className}`}>
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
            onChange={(event) => onSwitchAccount(connector.id, event.target.value)}
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
          Active connection: {connector.account.email ?? connector.account.displayName}
        </p>
      ) : null}

      <div className="connector-detail__actions">
        {connector.status === "connected" || connector.status === "fixture" ? (
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
            {detail.className === "expired" || detail.className === "revoked" || detail.className === "failed"
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
  if (sync.phase === "succeeded") return `Last synced ${sync.completedAt ?? "recently"}`;
  if (sync.phase === "partial") return `Partial: ${sync.failure?.message ?? "some items were skipped"}`;
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
  const hasMissingRequiredScopes = connector.scopes?.some((scope) => scope.required && !scope.granted) ?? false;
  const isStale = healthSummary.toLowerCase().includes("missing required") || healthSummary.toLowerCase().includes("stale");
  if (status === "connected" && (hasMissingRequiredScopes || isStale)) {
    return {
      label: "Permission Limited",
      className: "permission-limited",
      summary: `${connector.name} is missing required scopes or permissions.`
    };
  }

  // 2. Syncing
  if (status === "connected" && healthState === "unknown") {
    return {
      label: "Syncing",
      className: "syncing",
      summary: `Verifying connection with ${connector.name}...`
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
      summary
    };
  }

  // 4. Expired
  if (status === "expired" || healthSummary.toLowerCase().includes("expired")) {
    return {
      label: "Expired",
      className: "expired",
      summary: `${connector.name} authorization expired; reconnect or refresh is required.`
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
      summary: `${connector.name} was disconnected or revoked.`
    };
  }

  // 6. Configuration Required / Unconfigured
  const isUnconfigured =
    status === "unconfigured" || status === "unavailable" || status === "needs-auth";
  const hasConfigMsg = setupMessage?.toLowerCase().includes("broker") ||
    setupMessage?.toLowerCase().includes("config") ||
    setupMessage?.toLowerCase().includes("client_id") ||
    healthSummary.toLowerCase().includes("configuration");

  if (status === "unconfigured" || (isUnconfigured && hasConfigMsg)) {
    const summary = connector.authMode === "oauth-pkce"
      ? setupMessage ?? `${connector.name} requires a desktop OAuth client configuration.`
      : `${connector.name} is not configured on the Fable auth broker.`;
    return {
      label: "Configuration Required",
      className: "configuration-required",
      summary
    };
  }

  // 7. Unavailable
  if (status === "unavailable") {
    return {
      label: "Unavailable",
      className: "unavailable",
      summary: `${connector.name} service is temporarily unavailable.`
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
      summary: healthSummary || `Connection to ${connector.name} failed.`
    };
  }

  // 9. Fixture / Preview
  if (status === "fixture") {
    return {
      label: "Preview",
      className: "fixture",
      summary: healthSummary || "Preview mode active."
    };
  }

  if (status === "configured") {
    return {
      label: "Ready",
      className: "configured",
      summary: setupMessage ?? healthSummary
    };
  }

  // Default: unconfigured / Needs Authorization
  return {
    label: "Needs Authorization",
    className: "needs-auth",
    summary: setupMessage ?? healthSummary ?? `Connect your ${connector.name} account.`
  };
}

function actionLabel(action: ConnectorActionKind) {
  return action
    .split(".")
    .at(-1)!
    .replaceAll("-", " ");
}
