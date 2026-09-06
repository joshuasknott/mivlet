import type { ConnectorAccountOption, ConnectorManifest } from "@fable/protocol";
import { PluginPanel } from "../PluginPanel";

export function MarketplacePage({
  workspaceId,
  manifests,
  accounts,
  connectorStatus,
  onUseConnector,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelectConnector,
  onSwitchAccount,
}: {
  workspaceId?: string;
  manifests: ConnectorManifest[];
  accounts: Record<string, ConnectorAccountOption[]>;
  connectorStatus: string | null;
  onUseConnector: (connector: ConnectorManifest) => void;
  onConnect: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  onSelectConnector: (connector: ConnectorManifest) => void;
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
}) {
  return <section className="workspace marketplace-workspace" aria-label="Connectors">
    <div className="marketplace-scroll"><div className="marketplace-content">
            <PluginPanel
              key={workspaceId ?? "preview"}
              workspaceId={workspaceId}
              manifests={manifests}
              onUseConnector={onUseConnector}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onRefresh={onRefresh}
              onSelect={onSelectConnector}
              accounts={accounts}
              onSwitchAccount={onSwitchAccount}
            />
      {connectorStatus ? <p className="marketplace-runtime-status" role="status">{connectorStatus}</p> : null}
    </div></div>
  </section>;
}
