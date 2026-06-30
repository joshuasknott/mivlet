import { useMemo, useState } from "react";
import type {
  ConnectorAccountOption,
  ConnectorActionKind,
  ConnectorManifest
} from "@fable/protocol";
import { ConnectorIcon } from "./ConnectorIcon";

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
  onSwitchAccount: (connectorId: string, accountId: string) => void;
  onPrepareAction: (action: ConnectorActionKind, payload: Record<string, string>) => void;
}) {
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(
    manifests[0]?.id ?? null
  );
  const selectedConnector = useMemo(
    () => manifests.find((connector) => connector.id === selectedConnectorId) ?? manifests[0],
    [manifests, selectedConnectorId]
  );

  return (
    <section className="context-panel connectors-panel" aria-label="Connectors">
      <div className="connector-grid">
        {manifests.map((connector) => {
          const connected = connector.status === "connected";
          const selected = selectedConnector?.id === connector.id;

          return (
            <article
              className="connector-card"
              key={connector.id}
              data-connector-id={connector.id}
              data-selected={selected}
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
                <button
                  type="button"
                  className="connector-card__connect button button--secondary"
                  onClick={(event) => {
                    event.stopPropagation();
                    onConnect(connector);
                  }}
                >
                  Connect
                </button>
              ) : (
                <span className="connector-card__connected">Available</span>
              )}
            </article>
          );
        })}
      </div>

      {selectedConnector ? (
        <ConnectorDetails
          connector={selectedConnector}
          onUseConnector={onUseConnector}
          onDisconnect={onDisconnect}
          onRefresh={onRefresh}
          accounts={accounts[selectedConnector.id] ?? []}
          onSwitchAccount={onSwitchAccount}
          onPrepareAction={onPrepareAction}
        />
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
  onPrepareAction
}: {
  connector: ConnectorManifest;
  onUseConnector: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  accounts: ConnectorAccountOption[];
  onSwitchAccount: (connectorId: string, accountId: string) => void;
  onPrepareAction: (action: ConnectorActionKind, payload: Record<string, string>) => void;
}) {
  const firstAction = connector.supportedActions?.[0];
  const permissions = connector.scopes?.map((scope) => scope.label) ?? connector.permissions;

  return (
    <article className="connector-detail" aria-label={`${connector.name} details`}>
      <div className="connector-detail__header">
        <span className={`connector-card__logo-container connector-card__logo-container--${connector.id}`}>
          <ConnectorIcon id={connector.id} />
        </span>
        <div>
          <h2>{connector.name}</h2>
          <p>{connector.setupMessage ?? connector.healthSummary}</p>
        </div>
        <span className={`connector-detail__status connector-detail__status--${connector.status}`}>
          {statusLabel(connector)}
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
          <p>{connector.health?.summary ?? connector.healthSummary}</p>
        </div>
        <div>
          <span>Sync</span>
          <p>{syncLabel(connector)}</p>
        </div>
      </div>

      {connector.status === "connected" && accounts.length > 1 ? (
        <label className="connector-detail__account">
          <span>Active account</span>
          <select
            value={accounts.find((option) => option.active)?.account.id ?? connector.account?.id}
            onChange={(event) => onSwitchAccount(connector.id, event.target.value)}
          >
            {accounts.map(({ account }) => (
              <option key={account.id} value={account.id}>
                {account.email ?? account.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : connector.status === "connected" && connector.account ? (
        <p className="connector-detail__account">
          Active account: {connector.account.email ?? connector.account.displayName}
        </p>
      ) : null}

      <div className="connector-detail__actions">
        {connector.status === "connected" || connector.status === "fixture" ? (
          <button type="button" onClick={() => onUseConnector(connector)}>
            Use in composer
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

function statusLabel(connector: ConnectorManifest) {
  if (connector.status === "connected") {
    return "Connected";
  }
  if (connector.status === "fixture") {
    return "Preview";
  }
  return "Not connected";
}

function actionLabel(action: ConnectorActionKind) {
  return action
    .split(".")
    .at(-1)!
    .replaceAll("-", " ");
}
