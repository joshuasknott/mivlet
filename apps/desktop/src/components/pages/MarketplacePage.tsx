import type { ConnectorAccountOption, ConnectorManifest } from "@fable/protocol";
import { PluginPanel } from "../PluginPanel";

export function MarketplacePage({
  initialConnectorId,
  onBack,
  workspaceId,
  manifests,
  accounts,
  connectorStatus,
  onUseConnector,
  onUseBuiltinPlugin,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelectConnector,
  onSwitchAccount,
}: {
  initialConnectorId?: string;
  onBack?: () => void;
  workspaceId?: string;
  manifests: ConnectorManifest[];
  accounts: Record<string, ConnectorAccountOption[]>;
  connectorStatus: string | null;
  onUseConnector: (connector: ConnectorManifest) => void;
  onUseBuiltinPlugin?: (id: "browser" | "computer") => void;
  onConnect: (connector: ConnectorManifest) => void | Promise<void>;
  onDisconnect: (connectorId: string) => void | Promise<void>;
  onRefresh: (connectorId: string) => void;
  onSelectConnector: (connector: ConnectorManifest) => void;
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
}) {
  return <section className="workspace marketplace-workspace" aria-label="Plugins">
    <div className="marketplace-scroll"><div className="marketplace-content">
      {onBack ? <button type="button" className="marketplace-back" onClick={onBack}>← Back to chat</button> : null}
            <PluginPanel
              initialConnectorId={initialConnectorId}
              key={workspaceId ?? "preview"}
              workspaceId={workspaceId}
              manifests={manifests}
              onUseConnector={onUseConnector}
              onUseBuiltinPlugin={onUseBuiltinPlugin}
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
