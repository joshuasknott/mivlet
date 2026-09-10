import { useEffect, useRef, useState } from "react";
import { loadRuntimeConversationDraft, saveRuntimeConversationDraft } from "../runtime";
import type { ComposerAttachment } from "../lib/types";

export interface ComposerScope {
  workspaceId: string;
  accountId: string;
  agentId: string;
  projectId?: string;
  threadId?: string;
}
interface ComposerContent {
  text: string;
  attachments: ComposerAttachment[];
}
interface Entry {
  scope: ComposerScope;
  content: ComposerContent;
  ready: boolean;
  revision: number;
  error: string;
  timer?: ReturnType<typeof setTimeout>;
}
const empty = (): ComposerContent => ({ text: "", attachments: [] });
export const composerScopeKey = (scope: ComposerScope) => `composer-v1:${JSON.stringify([
  scope.workspaceId, scope.accountId, scope.projectId ? "project" : "agent",
  scope.projectId ?? scope.agentId, scope.threadId ?? "new",
])}`;

// Shared across remounts: a read/clear must not overtake an older in-flight save.
const writes = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  writes.set(key, next);
  void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
  return next;
}
function durableContent(content: ComposerContent): ComposerContent {
  return { ...content, attachments: content.attachments.map(({ imageInput: _image, previewUrl: _preview, ...attachment }) => ({
    ...attachment,
    // Image bytes are deliberately transient, never stored in draft payloads.
    status: attachment.type.startsWith("image/") ? "Reattach image before sending" : attachment.sourceId ? "Attached" : "Reattach file before sending",
  })) };
}
function decode(content: string): ComposerContent {
  const value = JSON.parse(content) as ComposerContent;
  if (!value || typeof value.text !== "string" || !Array.isArray(value.attachments)
    || value.attachments.length > 12 || value.attachments.some((a) => !a || typeof a.id !== "string" || typeof a.name !== "string" || typeof a.type !== "string" || typeof a.sizeBytes !== "number" || (a.sourceId !== undefined && typeof a.sourceId !== "string"))
  ) {
    throw new Error("Could not restore this conversation's composer.");
  }
  return durableContent(value);
}

/** One owner for text, attachments, and previously submitted source references. */
export function useScopedComposer(scope?: ComposerScope) {
  const entries = useRef(new Map<string, Entry>());
  const identity = scope ? JSON.stringify([scope.workspaceId, scope.accountId]) : "";
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const key = scope ? composerScopeKey(scope) : "";
  const [, render] = useState(0);
  const mounted = useRef(true);
  const repaint = () => { if (mounted.current) render((n) => n + 1); };
  const allowed = (entry: Entry) => currentIdentity.current === JSON.stringify([entry.scope.workspaceId, entry.scope.accountId]);
  const persist = (entry: Entry) => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.ready || !allowed(entry)) return Promise.resolve();
    const content = JSON.stringify(durableContent(entry.content));
    const draftKey = composerScopeKey(entry.scope);
    return serialize(draftKey, async () => {
      if (!allowed(entry)) throw new Error("The account or workspace changed before the draft was saved.");
      await saveRuntimeConversationDraft({ draftKey, threadId: entry.scope.threadId, content, updatedAt: new Date().toISOString() }, entry.scope.workspaceId);
    }).then(() => { entry.error = ""; repaint(); }, (error: unknown) => {
      entry.error = error instanceof Error ? error.message : "Could not save this draft.";
      repaint();
      throw error;
    });
  };
  let entry = entries.current.get(key);
  if (scope && !entry) {
    entry = { scope, content: empty(), ready: false, revision: 0, error: "" };
    entries.current.set(key, entry);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const pending of entries.current.values()) if (pending.timer) void persist(pending).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!entry) return;
    const target = entry;
    if (!target.ready) {
      const revision = target.revision;
      void serialize(key, async () => {
        const draft = await loadRuntimeConversationDraft(key, target.scope.workspaceId, target.scope.threadId);
        if (draft || !target.scope.threadId) return { draft, legacy: false };
        // Thread ownership is already validated by the native repository, so a
        // pre-scoping thread draft can be migrated safely. The old global
        // new-thread slot is deliberately never imported into an agent/project.
        const legacy = await loadRuntimeConversationDraft(`thread:${target.scope.threadId}`, target.scope.workspaceId, target.scope.threadId);
        return { draft: legacy, legacy: Boolean(legacy) };
      }).then(({ draft, legacy }) => {
        if (!allowed(target)) return;
        if (target.revision === revision) target.content = draft
          ? legacy ? { text: draft.content, attachments: [] } : decode(draft.content)
          : empty();
        target.ready = true;
        if (target.revision !== revision || legacy) void persist(target).catch(() => undefined);
        repaint();
      }).catch((error: unknown) => {
        if (!allowed(target)) return;
        if (target.revision === revision) target.content = empty();
        target.ready = true;
        if (target.revision !== revision) void persist(target).catch(() => undefined);
        target.error = error instanceof Error ? error.message : "Could not load this draft.";
        repaint();
      });
    }
    return () => { if (target.timer) void persist(target).catch(() => undefined); };
  }, [key]);
  const mutate = (change: (content: ComposerContent) => ComposerContent) => {
    if (!entry || !allowed(entry)) return;
    entry.content = change(entry.content);
    entry.revision++;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void persist(entry).catch(() => undefined); }, 400);
    repaint();
  };
  return {
    key,
    ready: Boolean(entry?.ready),
    error: entry?.error ?? "",
    text: entry?.ready ? entry.content.text : "",
    attachments: entry?.ready ? entry.content.attachments : [],
    setText: (text: string) => mutate((content) => ({ ...content, text })),
    setAttachments: (update: (attachments: ComposerAttachment[]) => ComposerAttachment[]) => mutate((content) => ({ ...content, attachments: update(content.attachments) })),
    flush: () => entry ? persist(entry) : Promise.resolve(),
    consume: async () => {
      const attachments = entry?.content.attachments ?? [];
      mutate(() => empty());
      if (entry) await persist(entry);
      return attachments;
    },
    moveToThread: async (threadId: string) => {
      if (!entry?.ready || !allowed(entry)) throw new Error("Wait for this draft to load before sending.");
      const destinationScope = { ...entry.scope, threadId };
      const destination: Entry = { scope: destinationScope, content: entry.content, ready: true, revision: 1, error: "" };
      entries.current.set(composerScopeKey(destinationScope), destination);
      await persist(destination);
      // Clear the old new-conversation slot before navigation, after its pending writes.
      mutate(() => empty());
      await persist(entry);
    },
  };
}
