import { PuzzlePiece } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { PluginPanel } from "../PluginPanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { connectors } from "../../data/workspace";

/**
 * Standalone Plugins page. Shows connector manifests with health, permissions,
 * and a "use in composer" / "prepare auth" action.
 */
export function PluginsPage({ runtime }: { runtime: ShellRuntime }) {
  const ready = connectors.filter(
    (connector) => connector.status === "connected" || connector.status === "fixture"
  ).length;
  return (
    <>
    <PageHeader
      icon={PuzzlePiece}
      title="Plugins"
      description="Bridges to your tools, gated behind explicit permissions. Fixtures are preview data — no live credentials are stored."
      meta={`${ready} ready · ${connectors.length} total`}
    />
    <PluginPanel manifests={connectors} onUseConnector={runtime.useConnector} />
    </>
  );
}
