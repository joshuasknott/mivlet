import type { LocalComputerFilesSnapshot, LocalComputerSnapshot, LocalComputerTarget } from "@mivlet/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { getActiveRuntimeDataScope } from "../runtime-scope";
import { listRuntimeLocalComputerFiles, loadRuntimeLocalComputer } from "../runtime/domains/local-computer";

const scopeIds = new WeakMap<object, number>();
let nextScopeId = 0;
/** A fresh verified account/workspace scope never inherits the previous cache. */
export function localComputerDataScope() {
  const scope = getActiveRuntimeDataScope();
  if (!scope) return { scope, id: 0 };
  let id = scopeIds.get(scope);
  if (!id) { id = ++nextScopeId; scopeIds.set(scope, id); }
  return { scope, id };
}

const reads = new WeakMap<QueryClient, Map<string, LocalComputerReads>>();
interface LocalComputerReads {
  queryKey: readonly [string, number, string | undefined, string | undefined];
  filesKey: readonly [string, number, string | undefined, string | undefined];
  target: LocalComputerTarget | null;
  epoch: number;
  fileEpoch: number;
  version: number;
  fileRevision?: string;
  node: LocalComputerSnapshot | null;
  disconnected: boolean;
  failure: string | null;
  consumers: Map<string, { notify: () => void; polling: boolean }>;
  owners: Set<string>;
  reading: { epoch: number; promise: Promise<LocalComputerSnapshot | null> } | null;
  fileReading: { epoch: number; promise: Promise<LocalComputerFilesSnapshot | null> } | null;
  current: () => boolean;
  leader: () => string | undefined;
  subscribe: (id: string, notify: () => void, polling?: boolean) => () => void;
  invalidateFiles: () => void;
  notify: () => void;
  read: () => Promise<LocalComputerSnapshot | null>;
  readFiles: (revision?: string) => Promise<LocalComputerFilesSnapshot | null>;
}
export function getLocalComputerReads(client: QueryClient, target: LocalComputerTarget | null, dataScope: ReturnType<typeof localComputerDataScope>) {
  let scopes = reads.get(client);
  if (!scopes) { scopes = new Map(); reads.set(client, scopes); }
  const registry = scopes;
  const key = JSON.stringify([dataScope.id, target?.workspaceId, target?.agentId]);
  let shared = scopes.get(key);
  if (!shared) {
    shared = createReads(client, target, dataScope, () => registry.delete(key));
    scopes.set(key, shared);
  }
  return shared;
}

function createReads(client: QueryClient, target: LocalComputerTarget | null, dataScope: ReturnType<typeof localComputerDataScope>, dispose: () => void) {
  const queryKey = ["local-computer", dataScope.id, target?.workspaceId, target?.agentId] as const;
  const filesKey = ["local-computer-files", dataScope.id, target?.workspaceId, target?.agentId] as const;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const shared: LocalComputerReads = {
    queryKey, filesKey, target, epoch: 0, fileEpoch: 0, version: 0,
    node: null as LocalComputerSnapshot | null, disconnected: false, failure: null as string | null,
    consumers: new Map(), owners: new Set(),
    reading: null as { epoch: number; promise: Promise<LocalComputerSnapshot | null> } | null,
    fileReading: null as { epoch: number; promise: Promise<LocalComputerFilesSnapshot | null> } | null,
    current: () => getActiveRuntimeDataScope() === dataScope.scope,
    leader: () => [...shared.consumers].find(([, consumer]) => consumer.polling)?.[0],
    notify: () => {
      shared.version++;
      for (const listener of shared.consumers.values()) listener.notify();
    },
    subscribe: (id: string, notify: () => void, polling = true) => {
      clearTimeout(releaseTimer);
      shared.consumers.set(id, { notify, polling });
      for (const listener of shared.consumers.values()) listener.notify();
      return () => {
        shared.consumers.delete(id);
        for (const listener of shared.consumers.values()) listener.notify();
        if (!shared.consumers.size) {
          shared.epoch++; shared.fileEpoch++;
          releaseTimer = setTimeout(dispose, 0);
        }
      };
    },
    invalidateFiles: () => {
      shared.fileEpoch++;
      // Clear visible metadata immediately; native checks still own every open.
      client.setQueriesData({ queryKey: filesKey }, null);
      void client.invalidateQueries({ queryKey: filesKey });
      shared.notify();
    },
    read: async (): Promise<LocalComputerSnapshot | null> => {
      if (!target || !shared.current()) return null;
      if (shared.reading?.epoch === shared.epoch) return shared.reading.promise;
      const epoch = shared.epoch;
      const promise = loadRuntimeLocalComputer(target).then(node => {
        if (epoch !== shared.epoch || !shared.current()) return null;
        if (node && (node.workspaceId !== target.workspaceId || node.agentId !== target.agentId || node.generation < (shared.node?.generation ?? 0))) return shared.node;
        const generationChanged = node?.generation !== shared.node?.generation;
        const recovered = shared.disconnected;
        shared.node = node; shared.disconnected = false; shared.failure = null;
        if (generationChanged) shared.invalidateFiles();
        else if (recovered) shared.notify();
        return node;
      }).catch((error: unknown) => {
        if (epoch === shared.epoch && shared.current()) {
          shared.disconnected = true;
          shared.failure = error instanceof Error ? error.message : "Computer status could not be refreshed.";
          shared.epoch++; shared.invalidateFiles();
          client.setQueryData(queryKey, null);
        }
        throw error;
      }).finally(() => { if (shared.reading?.promise === promise) shared.reading = null; });
      shared.reading = { epoch, promise };
      return promise;
    },
    readFiles: async (revision?: string): Promise<LocalComputerFilesSnapshot | null> => {
      if (!target || !shared.current()) return null;
      if (revision !== undefined && revision !== shared.fileRevision) {
        if (shared.fileRevision !== undefined) {
          shared.fileEpoch++;
          client.setQueriesData({ queryKey: filesKey }, null);
          shared.notify();
        }
        shared.fileRevision = revision;
      }
      if (shared.fileReading?.epoch === shared.fileEpoch) return shared.fileReading.promise;
      const epoch = shared.fileEpoch;
      const promise = listRuntimeLocalComputerFiles(target).then(result => {
        if (!shared.current()) return null;
        if (epoch !== shared.fileEpoch) {
          // The scoped query cache owns bounded metadata; retain no second copy.
          const latest = client.getQueryData<LocalComputerFilesSnapshot | null>([...filesKey, shared.fileRevision]);
          return latest !== undefined ? latest : shared.consumers.size ? shared.readFiles() : null;
        }
        const node = !shared.node || result?.computerId === shared.node.computerId ? result : null;
        return node;
      }).catch((error: unknown) => {
        if (epoch === shared.fileEpoch && shared.current()) {
          shared.fileEpoch++;
          client.setQueriesData({ queryKey: filesKey }, null);
          shared.notify();
        }
        throw error;
      }).finally(() => { if (shared.fileReading?.promise === promise) shared.fileReading = null; });
      shared.fileReading = { epoch, promise };
      return promise;
    },
  };
  return shared;
}
