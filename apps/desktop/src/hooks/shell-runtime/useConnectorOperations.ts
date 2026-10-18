import {
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  ConnectorAccountOption,
  ConnectorManifest,
} from "@mivlet/protocol";
import {
  beginRuntimeConnectorOAuth,
  clearRuntimeConnectorAuth,
  listRuntimeConnectorAccounts,
  refreshRuntimeConnectorHealth,
  switchRuntimeConnectorAccount,
  syncRuntimeConnector,
} from "../../runtime/domains/connectors";
import { isSupportedConnectorId } from "./backend-normalization";

/** Owns connector mutations and their generation fences separately from shell hydration. */
export function useConnectorOperations({
  connectorScopeRef,
  connectorManifests,
  setConnectorManifests,
  setConnectorAccounts,
  setConnectorStatus,
  activeWorkspaceScope,
  setLastAction,
}: {
  connectorScopeRef: RefObject<number>;
  connectorManifests: ConnectorManifest[];
  setConnectorManifests: Dispatch<SetStateAction<ConnectorManifest[]>>;
  setConnectorAccounts: Dispatch<
    SetStateAction<Record<string, ConnectorAccountOption[]>>
  >;
  setConnectorStatus: Dispatch<SetStateAction<string | null>>;
  activeWorkspaceScope: { workspaceId: string } | null;
  setLastAction: (action: string) => void;
}) {
  const manifestsRef = useRef(connectorManifests);
  manifestsRef.current = connectorManifests;
  const workspaceRef = useRef(activeWorkspaceScope);
  workspaceRef.current = activeWorkspaceScope;
  const operations = useRef(new Map<string, Promise<void>>());

  const replaceConnectorManifest = (manifest: ConnectorManifest) => {
    setConnectorManifests((current) =>
      current.map((connector) =>
        connector.id === manifest.id ? manifest : connector,
      ),
    );
  };

  const loadConnectorAccounts = async (connectorId: string) => {
    const generation = connectorScopeRef.current;
    if (!isSupportedConnectorId(connectorId)) return;
    try {
      const accounts = await listRuntimeConnectorAccounts(connectorId);
      if (connectorScopeRef.current !== generation) return;
      if (accounts) {
        setConnectorAccounts((current) => ({
          ...current,
          [connectorId]: accounts,
        }));
      }
    } catch (error) {
      if (connectorScopeRef.current !== generation) return;
      setConnectorStatus(
        error instanceof Error
          ? error.message
          : "Connected accounts are unavailable.",
      );
    }
  };

  const connectConnector = (connector: ConnectorManifest): Promise<void> => {
    const generation = connectorScopeRef.current;
    const key = `${generation}:${connector.id}`;
    const pending = operations.current.get(key);
    if (pending) return pending;
    const task = (async () => {
      if (!isSupportedConnectorId(connector.id)) {
        setConnectorStatus(
          connector.id === "local-files"
            ? "Local Files is already available."
            : (connector.setupMessage ??
                `${connector.name} is not in the first connector wave.`),
        );
        return;
      }

      setConnectorStatus(`Preparing ${connector.name} authorization...`);
      try {
        const result = await beginRuntimeConnectorOAuth({
          connectorId: connector.id,
          requestedScopes: connector.scopes?.length
            ? connector.scopes.map((scope) => scope.id)
            : undefined,
        });
        if (!result) {
          const message = `${connector.name} connections require the installed desktop app.`;
          setConnectorStatus(message);
          setLastAction(message);
          throw new Error(message);
        }
        if (result.status === "connected") {
          if (connectorScopeRef.current !== generation) return;
          const refreshed = await refreshRuntimeConnectorHealth(connector.id);
          if (connectorScopeRef.current !== generation) return;
          if (refreshed) replaceConnectorManifest(refreshed);
          if (
            !refreshed ||
            refreshed.status !== "connected" ||
            refreshed.health?.state !== "healthy"
          ) {
            throw new Error(
              refreshed?.healthSummary ??
                "Could not finish connecting. Try again.",
            );
          }
          await loadConnectorAccounts(connector.id);
        } else {
          throw new Error(
            result.message || "Sign-in did not finish. Try again.",
          );
        }
        if (connectorScopeRef.current !== generation) return;
        setConnectorStatus(result.message);
        setLastAction(result.message);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `${connector.name} authorization is unavailable.`;
        if (connectorScopeRef.current !== generation) return;
        setConnectorStatus(message);
        setLastAction(message);
        throw new Error(message);
      }
    })().finally(() => {
      operations.current.delete(key);
    });
    operations.current.set(key, task);
    return task;
  };

  const disconnectConnector = async (connectorId: string) => {
    const generation = connectorScopeRef.current;
    const connector = manifestsRef.current.find(
      (manifest) => manifest.id === connectorId,
    );
    if (!connector || !isSupportedConnectorId(connectorId)) return;
    try {
      const manifest = await clearRuntimeConnectorAuth(connectorId);
      if (connectorScopeRef.current !== generation) return;
      if (manifest) {
        replaceConnectorManifest(manifest);
        setConnectorStatus(`${connector.name} disconnected.`);
      } else {
        throw new Error(
          `${connector.name} connections require the installed desktop app.`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `${connector.name} could not be disconnected.`;
      if (connectorScopeRef.current !== generation) return;
      setConnectorStatus(message);
      throw new Error(message);
    }
  };

  const switchConnectorAccount = async (
    connectorId: string,
    connectionId: string,
  ) => {
    const generation = connectorScopeRef.current;
    if (!isSupportedConnectorId(connectorId)) return;
    try {
      const manifest = await switchRuntimeConnectorAccount(
        connectorId,
        connectionId,
      );
      if (connectorScopeRef.current !== generation) return;
      if (manifest) {
        replaceConnectorManifest(manifest);
        await loadConnectorAccounts(connectorId);
        if (connectorScopeRef.current !== generation) return;
        setConnectorStatus(
          `Using ${manifest.account?.email ?? manifest.account?.displayName ?? "selected account"}.`,
        );
      }
    } catch (error) {
      if (connectorScopeRef.current !== generation) return;
      setConnectorStatus(
        error instanceof Error
          ? error.message
          : "The account could not be selected.",
      );
    }
  };

  const refreshConnector = async (connectorId: string) => {
    const generation = connectorScopeRef.current;
    const connector = manifestsRef.current.find(
      (manifest) => manifest.id === connectorId,
    );
    if (!connector || !isSupportedConnectorId(connectorId)) return;
    const workspaceId = workspaceRef.current?.workspaceId ?? "";
    try {
      const sync = await syncRuntimeConnector({
        connectorId,
        workspaceId,
        trigger: "manual",
      });
      if (connectorScopeRef.current !== generation) return;
      if (sync) {
        replaceConnectorManifest({ ...connector, sync });
        const outcome =
          sync.phase === "succeeded"
            ? "sync complete"
            : (sync.failure?.message ?? `sync ${sync.phase}`);
        setConnectorStatus(`${connector.name} ${outcome}.`);
      } else {
        setConnectorStatus(
          `${connector.name} sync is unavailable in preview mode.`,
        );
      }
    } catch (error) {
      if (connectorScopeRef.current !== generation) return;
      setConnectorStatus(
        error instanceof Error
          ? error.message
          : `${connector.name} health is unavailable.`,
      );
    }
  };

  return {
    connectConnector,
    disconnectConnector,
    refreshConnector,
    loadConnectorAccounts,
    switchConnectorAccount,
  };
}
