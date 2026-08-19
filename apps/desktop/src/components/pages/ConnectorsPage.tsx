import { PageHeader } from "../PageHeader";
import { PluginPanel } from "../PluginPanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Minimal connection setup surface. The app shell owns navigation; this page
 * only renders the icon-led catalogue and the selected connection details.
 */
export function ConnectorsPage({ runtime }: { runtime: ShellRuntime }) {
  const visibleConnectors = runtime.connectorManifests.filter(
    (connector) => connector.id !== "local-files"
  );
  const connected = visibleConnectors.filter((connector) => connector.status === "connected").length;
  const sessionLabel =
    runtime.browserSession.source === "fixture-preview"
      ? "Preview data only"
      : runtime.browserSession.lifecycle === "active"
        ? "Active session"
        : runtime.browserSession.lifecycle === "starting"
          ? "Starting session"
          : runtime.browserSession.lifecycle === "expired" || runtime.browserSession.lifecycle === "closed"
            ? "Session closed"
            : runtime.browserSession.lifecycle === "failed"
              ? "Session failed"
              : "No active session";

  return (
    <>
      <PageHeader
        title="Connections"
        description="Let your agents use the apps and services you choose."
        meta={`${connected} installed · ${sessionLabel}`}
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
