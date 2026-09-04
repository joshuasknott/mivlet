/** Shared first-run screens with explicit in-memory fixtures; no auth or transport. */
import { useEffect, useState } from "react";
import type { BackendVerifyResult, ConnectorManifest } from "@fable/protocol";
import { listSupportedConnectors } from "@fable/connectors";
import { listBackendProviders } from "@fable/connectors/backends/registry";
import { OnboardingPage } from "../components/pages/OnboardingPage";
import {
  DEFAULT_IDENTITY_STATUS,
  PREVIEW_IDENTITY_STATUS,
} from "../hooks/shell-runtime/defaults";
import "./design-preview.css";

export function OnboardingPreview() {
  const [identity, setIdentity] = useState(DEFAULT_IDENTITY_STATUS);
  const [connected, setConnected] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<ConnectorManifest[]>(() =>
    listSupportedConnectors().map((connector) => ({
      ...connector,
      status: "needs-auth",
    })),
  );
  const [theme, setTheme] = useState(
    new URLSearchParams(window.location.search).get("theme") === "dark"
      ? "dark"
      : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const connect = async (providerId: string): Promise<BackendVerifyResult> => {
    setConnected((current) => [...new Set([...current, providerId])]);
    return {
      providerId,
      outcome: "ready",
      message: "Simulated connection in the design preview.",
    };
  };
  return (
    <>
      <OnboardingPage
        providers={listBackendProviders()}
        connectedBackendIds={connected}
        status={null}
        identityStatus={identity}
        identityPending={false}
        onSignIn={() => setIdentity(PREVIEW_IDENTITY_STATUS)}
        onConnectWithVerify={connect}
        onStartBrowserLogin={connect}
        onCheckConnection={connect}
        connectors={connectors}
        connectorStatus={null}
        onConnectConnector={(selected) =>
          setConnectors((current) =>
            current.map((connector) =>
              connector.id === selected.id
                ? { ...connector, status: "connected" }
                : connector,
            ),
          )
        }
        onComplete={() => {
          window.location.href = "/design-preview.html";
        }}
      />
      <div className="design-preview-notice">
        <span>Design preview · Simulated setup</span>
        <button
          type="button"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? "Dark" : "Light"}
        </button>
        <a href="/design-preview.html">Workspace</a>
      </div>
    </>
  );
}
