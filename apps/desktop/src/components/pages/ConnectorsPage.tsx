import { PuzzlePiece } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { PluginPanel } from "../PluginPanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Minimal connector setup surface. The app shell owns navigation; this page
 * only renders the icon-led connector grid and the selected connector details.
 */
export function ConnectorsPage({ runtime }: { runtime: ShellRuntime }) {
  const visibleConnectors = runtime.connectorManifests.filter(
    (connector) => connector.id !== "local-files"
  );
  const connected = visibleConnectors.filter((connector) => connector.status === "connected").length;

  return (
    <>
      <PageHeader
        icon={PuzzlePiece}
        title="Connectors"
        description="Connect Fable to the tools you explicitly choose."
        meta={`${connected} of ${visibleConnectors.length} connected`}
      />

      <PluginPanel
        manifests={visibleConnectors}
        onUseConnector={runtime.useConnector}
        onConnect={(connector) => void runtime.connectConnector(connector)}
        onDisconnect={(connectorId) => void runtime.disconnectConnector(connectorId)}
        onRefresh={(connectorId) => void runtime.refreshConnector(connectorId)}
        accounts={runtime.connectorAccounts}
        onSwitchAccount={(connectorId, accountId) =>
          void runtime.switchConnectorAccount(connectorId, accountId)
        }
        onSelect={(connector) => void runtime.loadConnectorAccounts(connector.id)}
        onPrepareAction={(action, payload) =>
          void runtime.prepareConnectorAction(action, payload)
        }
      />
    </>
  );
}
