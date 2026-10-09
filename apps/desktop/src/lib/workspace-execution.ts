import type {
  BackendProvider,
  CollaborationCommand,
  CollaborationSnapshot,
  CollaborationWorkItem,
  MivletAgentProfile,
  PermissionMode,
  WorkAttachment,
} from "@mivlet/protocol";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import type { ComposerAttachment } from "./types";
import {
  commandCollaboration,
  loadCollaboration,
} from "../runtime/domains/collaboration";
import {
  loadDesktopConversation,
  loadDesktopConversationPage,
} from "../hooks/useDurableConversation";
import type { HydratedConversation } from "./conversation-runtime";
import {
  resolveProviderModelOption,
  type ProviderModelOption,
} from "./provider-models";
import { ExecutionApprovalRouter } from "./execution-approvals";
import { permissionModeFor } from "./agent-run";

export const activeWork = (work: CollaborationWorkItem) =>
  ["queued", "running", "waiting", "awaiting-approval"].includes(work.status);
const workKey = (work: CollaborationWorkItem) =>
  `${work.id}:${work.generation}:${work.runIds.length}`;
export const restrictedPermission = (
  ...modes: PermissionMode[]
): PermissionMode =>
  modes.includes("read-only")
    ? "read-only"
    : modes.includes("trusted-scope")
      ? "trusted-scope"
      : "full-access";

/** Durable reference preview captured with the request before staging. */
export function composerAttachmentRefs(
  attachments: readonly ComposerAttachment[],
): WorkAttachment[] {
  return attachments.map((attachment) => {
    if (attachment.workspaceFile)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.workspaceFile.mimeType,
        sizeBytes: attachment.sizeBytes,
        availability: "workspace-file",
        relativePath: attachment.workspaceFile.relativePath,
        sha256: attachment.workspaceFile.sha256,
      };
    if (attachment.sourceId)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.type,
        sizeBytes: attachment.sizeBytes,
        availability: "knowledge-context",
        sourceId: attachment.sourceId,
      };
    if (attachment.imageInput)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.type,
        sizeBytes: attachment.sizeBytes,
        availability: "image-input",
      };
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.type,
      sizeBytes: attachment.sizeBytes,
      availability: "transient",
    };
  });
}

/** Final staged references recorded at dispatch for durable recovery. */
export function stagedAttachmentRefs(
  attachments: readonly ComposerAttachment[],
): WorkAttachment[] {
  return attachments.map((attachment) => {
    if (attachment.durableRef) return attachment.durableRef;
    if (attachment.workspaceFile)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.workspaceFile.mimeType,
        sizeBytes: attachment.sizeBytes,
        availability: "workspace-file",
        relativePath: attachment.workspaceFile.relativePath,
        sha256: attachment.workspaceFile.sha256,
      };
    if (attachment.sourceId)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.type,
        sizeBytes: attachment.sizeBytes,
        availability: "knowledge-context",
        sourceId: attachment.sourceId,
      };
    if (attachment.imageInput)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.type,
        sizeBytes: attachment.sizeBytes,
        availability: "image-input",
      };
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.type,
      sizeBytes: attachment.sizeBytes,
      availability: "transient",
    };
  });
}

export interface ExecutionSession {
  key: string;
  work: CollaborationWorkItem;
  profile: MivletAgentProfile;
  model: ProviderModelOption;
  permissionMode: PermissionMode;
  attachments: ComposerAttachment[];
  cancelled: boolean;
  started: boolean;
  cancel?: () => Promise<unknown>;
  approvalIds: Set<string>;
  state?: NativeAgentState;
}

const empty = (): CollaborationSnapshot => ({
  conversations: [],
  authors: [],
  teams: [],
  work: [],
  facts: [],
  layout: null,
});
export interface WorkspaceExecutionState {
  data: CollaborationSnapshot;
  sessions: ExecutionSession[];
  histories: Record<string, HydratedConversation | null>;
  loading: boolean;
  error: string | null;
  revision: number;
}

export interface ScheduledWorkResult {
  terminal: "completed" | "failed" | "interrupted" | "needs-user";
  threadId: string;
  message?: string;
}

function scheduledResult(work: CollaborationWorkItem): ScheduledWorkResult {
  return {
    terminal:
      work.status === "completed"
        ? "completed"
        : work.status === "failed"
          ? "failed"
          : work.status === "awaiting-user" || work.status === "blocked"
            ? "needs-user"
            : "interrupted",
    threadId: work.conversationId,
    message: work.reason,
  };
}

/** App-lifetime owner. Views subscribe; only admitted sessions can dispatch. */
export class WorkspaceExecution {
  private state: WorkspaceExecutionState = {
    data: empty(),
    sessions: [],
    histories: {},
    loading: true,
    error: null,
    revision: 0,
  };
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private reads = new Map<string, Promise<void>>();
  private olderReads = new Map<string, Promise<boolean>>();
  private attachments = new Map<string, ComposerAttachment[]>();
  private effortAttachments = new Map<string, ComposerAttachment[]>();
  private stopping = new Set<string>();
  private external = new Map<string, () => Promise<void>>();
  private scheduled = new Map<
    string,
    {
      threadId: string;
      bind: (attemptId: string) => Promise<void>;
      finish: (result: ScheduledWorkResult) => void;
    }
  >();
  private disposed = false;
  private closing: Promise<void> | null = null;
  constructor(
    readonly workspaceId: string,
    private transport = {
      load: loadCollaboration,
      command: commandCollaboration,
    },
    readonly approvals = new ExecutionApprovalRouter(),
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  private emit(patch: Partial<WorkspaceExecutionState> = {}) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  report(error: unknown) {
    this.emit({
      error: error instanceof Error ? error.message : String(error),
    });
  }
  clearError() {
    this.emit({ error: null });
  }
  registerScheduled(id: string, cancel: () => Promise<void>) {
    this.external.set(id, cancel);
    return () => {
      this.external.delete(id);
    };
  }
  /** Occurrence claims stay in memory; the ordinary worker owns all execution. */
  async runScheduledWork(
    workId: string,
    threadId: string,
    bind: (attemptId: string) => Promise<void>,
    onReady: (cancel: () => Promise<void>) => void,
  ) {
    if (this.disposed) throw new Error("This workspace has closed.");
    if (this.scheduled.has(workId))
      throw new Error("This schedule occurrence is already admitted.");
    let finish!: (result: ScheduledWorkResult) => void;
    const completed = new Promise<Parameters<typeof finish>[0]>((resolve) => {
      finish = resolve;
    });
    this.scheduled.set(workId, { threadId, bind, finish });
    try {
      onReady(() => this.stop(workId));
      await this.refresh();
      if (
        this.state.data.work.find((work) => work.id === workId)
          ?.conversationId !== threadId
      )
        throw new Error("This scheduled Work is unavailable or changed.");
      return await completed;
    } finally {
      this.scheduled.delete(workId);
    }
  }
  async bindScheduledWork(session: ExecutionSession, attemptId: string) {
    if (!session.work.schedule) return;
    const schedule = this.scheduled.get(session.work.id);
    if (!schedule || !this.current(session))
      throw new Error("This schedule no longer owns its execution claim.");
    await schedule.bind(attemptId);
  }
  canSchedule(agentId: string, providerId: string) {
    const active = this.state.data.work.filter(
      (work) =>
        work.status === "running" || work.status === "awaiting-approval",
    );
    const occupied = [
      ...new Map(
        [...active, ...this.state.sessions.map((session) => session.work)].map(
          (work) => [work.id, work],
        ),
      ).values(),
    ];
    return (
      !this.disposed &&
      occupied.length < 3 &&
      !occupied.some((work) => work.agentId === agentId) &&
      occupied.filter((work) =>
        work.modelOptionId.startsWith(`${providerId}::`),
      ).length < 2
    );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail
      .catch(() => undefined)
      .then(() => {
        if (this.disposed) throw new Error("This workspace has closed.");
        return fn();
      });
    this.tail = next;
    return next;
  }
  private executingWork() {
    return this.state.data.work.filter(
      (work) =>
        work.status === "running" || work.status === "awaiting-approval",
    );
  }
  private accept(data: CollaborationSnapshot) {
    if (this.disposed) return;
    for (const [id, scheduled] of this.scheduled) {
      const work = data.work.find((work) => work.id === id);
      if (!work || !activeWork(work))
        scheduled.finish(
          work
            ? scheduledResult(work)
            : {
                terminal: "interrupted",
                threadId: scheduled.threadId,
                message: "The automation Work is no longer available.",
              },
        );
    }
    for (const rootId of this.effortAttachments.keys()) {
      const effort = data.work.filter((work) => work.rootId === rootId);
      if (
        effort.length &&
        effort.every((work) => ["completed", "cancelled"].includes(work.status))
      ) {
        this.effortAttachments.delete(rootId);
      }
    }
    for (const [id, cancel] of this.external) {
      const item = data.work.find((work) => work.id === id);
      if (item && !activeWork(item))
        void cancel().catch((error) => this.report(error));
    }
    for (const session of this.state.sessions) {
      const current = data.work.find((work) => work.id === session.work.id);
      if (
        !current ||
        current.generation !== session.work.generation ||
        !activeWork(current)
      ) {
        session.cancelled = true;
        void session.cancel?.().catch((error) => this.report(error));
      }
    }
    this.emit({
      data: {
        ...data,
        conversations: [...data.conversations].sort((a, b) =>
          a.updatedAt.localeCompare(b.updatedAt),
        ),
        work: [...data.work].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
        facts: [...data.facts].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
      },
      loading: false,
    });
  }
  refresh = () =>
    this.serial(async () => {
      this.accept(await this.transport.load(this.workspaceId));
    });
  command = (command: CollaborationCommand) =>
    this.serial(async () => {
      const data = await this.transport.command(this.workspaceId, command);
      this.accept(data);
      return data;
    });
  steer(id: string, expectedGeneration: number, text: string) {
    return this.command({
      action: "steer-work",
      id,
      expectedGeneration,
      eventId: crypto.randomUUID(),
      text,
    });
  }
  reply(id: string, expectedGeneration: number, text: string) {
    return this.command({
      action: "reply-work",
      id,
      expectedGeneration,
      eventId: crypto.randomUUID(),
      text,
    });
  }
  async submit(
    conversationId: string,
    agentId: string,
    prompt: string,
    discussion: boolean,
    attachments: ComposerAttachment[],
    recipientIds?: string[],
    parentMessageId?: string,
    requestId?: string,
  ) {
    const id = requestId ?? `work-${crypto.randomUUID()}`;
    this.attachments.set(id, [...attachments]);
    this.effortAttachments.set(id, [...attachments]);
    try {
      await this.command({
        action: "start-work",
        id,
        conversationId,
        agentId,
        prompt,
        discussion,
        parentMessageId,
        recipientIds,
        attachments: composerAttachmentRefs(attachments),
      });
      return id;
    } catch (error) {
      this.attachments.delete(id);
      this.effortAttachments.delete(id);
      throw error;
    }
  }
  /** Conservative app limits; native providers and the computer lease still arbitrate resources. */
  admit(
    profiles: MivletAgentProfile[],
    models: ProviderModelOption[],
    providers: BackendProvider[],
    permissionMode: PermissionMode,
  ) {
    if (this.disposed || this.state.loading) return;
    const sessions = [...this.state.sessions];
    let changed = false;
    for (const work of this.state.data.work.filter(
      (work) => work.status === "queued" && work.executionOwner !== "native-background",
    )) {
      if (work.schedule && !this.scheduled.has(work.id)) continue;
      const external = this.state.data.work.filter(
        (work) =>
          ["running", "awaiting-approval"].includes(work.status) &&
          !sessions.some((session) => session.work.id === work.id),
      );
      if (sessions.length + external.length >= 3) break;
      if (
        this.stopping.has(work.id) ||
        this.stopping.has(work.rootId) ||
        external.some((item) => item.agentId === work.agentId) ||
        sessions.some(
          (session) =>
            session.work.id === work.id ||
            session.work.agentId === work.agentId,
        )
      )
        continue;
      const profile = profiles.find((profile) => profile.id === work.agentId);
      const model = resolveProviderModelOption(models, work.modelOptionId);
      const provider = providers.find(
        (provider) =>
          provider.id === model?.providerId &&
          provider.authState === "connected",
      );
      if (!profile || !model || !provider) {
        this.stopping.add(work.id);
        void this.command({
          action: "work-status",
          id: work.id,
          generation: work.generation,
          status: "failed",
          reason: !profile
            ? "This teammate was removed. Choose a current participant."
            : "The saved provider or model is unavailable. Reconnect it and explicitly continue.",
        })
          .catch((error) => this.report(error))
          .finally(() => this.stopping.delete(work.id));
        continue;
      }
      const limit =
        provider.backendType === "native-api" ||
        provider.backendType === "codex-app-server"
          ? 2
          : 1;
      if (
        sessions.filter((session) => session.model.providerId === provider.id)
          .length +
          external.filter((work) =>
            work.modelOptionId.startsWith(`${provider.id}::`),
          ).length >=
        limit
      )
        continue;
      if (
        work.prerequisites.some(
          (id) =>
            this.state.data.work.find((other) => other.id === id)?.status !==
            "completed",
        )
      )
        continue;
      const root = this.state.data.work.find(
        (other) => other.id === work.rootId,
      );
      if (
        !root ||
        root.turnCount >= root.maxTurns ||
        root.tokenUsage >= root.maxTokens
      ) {
        this.stopping.add(work.id);
        void this.command({
          action: "work-status",
          id: work.id,
          generation: work.generation,
          status: "failed",
          reason:
            "The exchange reached its turn or usage budget. Review saved results before explicitly continuing.",
        })
          .catch((error) => this.report(error))
          .finally(() => this.stopping.delete(work.id));
        continue;
      }
      sessions.push({
        key: workKey(work),
        work,
        profile: {
          ...profile,
          ...(work.schedule
            ? { reasoningEffort: work.schedule.reasoningEffort }
            : {}),
        },
        model,
        permissionMode: restrictedPermission(
          permissionMode,
          work.permissionMode,
          permissionModeFor(profile.permissionLabel),
        ),
        attachments:
          this.attachments.get(work.id) ??
          (work.parentId
            ? this.effortAttachments.get(work.rootId)
            : undefined) ??
          [],
        cancelled: false,
        started: false,
        approvalIds: new Set(),
      });
      changed = true;
    }
    if (changed) this.emit({ sessions });
  }
  publish(session: ExecutionSession, state: NativeAgentState) {
    if (session.cancelled || !this.state.sessions.includes(session)) return;
    session.state = state;
    this.emit();
  }
  approval(session: ExecutionSession, id: string) {
    session.approvalIds.add(id);
    this.emit();
  }
  current(session: ExecutionSession) {
    const work = this.state.data.work.find(
      (work) => work.id === session.work.id,
    );
    return (
      !this.disposed &&
      !session.cancelled &&
      !this.stopping.has(session.work.id) &&
      Boolean(
        work && work.generation === session.work.generation && activeWork(work),
      )
    );
  }
  async released(session: ExecutionSession) {
    this.approvals.release(session.key);
    const scheduled = this.scheduled.get(session.work.id);
    if (scheduled) {
      const work = this.state.data.work.find(
        (work) => work.id === session.work.id,
      );
      if (!work || !activeWork(work))
        scheduled.finish(
          scheduledResult(
            work ?? {
              ...session.work,
              status: "cancelled",
              reason: "The automation Work is no longer available.",
            },
          ),
        );
    }
    // Keep inputs for a same-session retry that failed before a durable run.
    // A bound run has already persisted its attachment metadata and context.
    if (
      this.state.data.work.find((work) => work.id === session.work.id)?.runIds
        .length
    )
      this.attachments.delete(session.work.id);
    this.emit({
      sessions: this.state.sessions.filter((current) => current !== session),
    });
    await this.loadHistory(session.work.conversationId, true).catch((error) =>
      this.report(error),
    );
  }
  async loadHistory(conversationId: string, force = false): Promise<void> {
    if (this.reads.has(conversationId)) return this.reads.get(conversationId);
    if (!force && Object.hasOwn(this.state.histories, conversationId)) return;
    const read = (typeof loadDesktopConversationPage === "function"
      ? loadDesktopConversationPage(conversationId, { limit: 80 })
      : loadDesktopConversation(conversationId))
      .then((history) => {
        if (history && history.thread.id !== conversationId)
          throw new Error("Conversation history scope mismatch.");
        if (!history || !force || !this.state.histories[conversationId]) {
          this.emit({
            histories: { ...this.state.histories, [conversationId]: history },
          });
          return;
        }
        // A forced refresh updates the tail and thread head without discarding
        // pages the reader already loaded above it.
        const current = this.state.histories[conversationId];
        const byId = new Map(
          [...current.messages, ...history.messages].map((view) => [
            String(view.message.id),
            view,
          ]),
        );
        this.emit({
          histories: {
            ...this.state.histories,
            [conversationId]: {
              thread: history.thread,
              messages: [...byId.values()].sort(
                (left, right) => left.message.sequence - right.message.sequence,
              ),
              // Keep the paging knowledge of the already loaded range. A
              // fresh bounded tail can report older rows even when an older
              // page was previously loaded to completion; reviving that
              // cursor would make the UI request the same page again.
              olderCursor:
                current.hasOlderMessages === false
                  ? current.olderCursor
                  : current.olderCursor ?? history.olderCursor,
              hasOlderMessages:
                current.hasOlderMessages ?? Boolean(history.hasOlderMessages),
              // The native page owns the complete branch-head set. A forced
              // refresh can advance a head past the currently loaded tail;
              // unioning snapshots would keep obsolete heads visible forever
              // (and make a linear multi-agent run look like alternatives).
              branchHeads: history.branchHeads ?? current.branchHeads,
            },
          },
        });
      })
      .finally(() => this.reads.delete(conversationId));
    this.reads.set(conversationId, read);
    return read;
  }
  /** Merge one older bounded page into the canonical transcript by durable ID. */
  async loadOlderHistory(conversationId: string): Promise<boolean> {
    const inFlight = this.olderReads.get(conversationId);
    if (inFlight) return inFlight;
    const current = this.state.histories[conversationId];
    if (!current?.hasOlderMessages || !current.olderCursor) return false;
    const beforeSequence = Number(current.olderCursor);
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0) return false;
    const read = (typeof loadDesktopConversationPage === "function"
      ? loadDesktopConversationPage(conversationId, {
          limit: 80,
          beforeSequence,
        })
      : Promise.resolve(null));
    const pending = read.then(async (older) => {
      if (!older || this.disposed) return false;
      if (older.thread.id !== conversationId)
        throw new Error("Conversation history scope mismatch.");
      if (
        older.messages.some(
          (view) =>
            view.message.threadId !== conversationId ||
            view.currentRevision.threadId !== conversationId,
        )
      )
        throw new Error("Conversation response contains a message outside its thread.");
      if (
        older.hasOlderMessages &&
        (!older.olderCursor || Number(older.olderCursor) >= beforeSequence)
      )
        return false;
      // A page can resolve after a streaming checkpoint or branch refresh.
      // Merge into the newest canonical snapshot and retain its thread head;
      // the page's thread metadata is only a read-time cursor companion.
      const latest = this.state.histories[conversationId];
      if (!latest || latest.thread.id !== conversationId) return false;
      if (latest.olderCursor !== current.olderCursor) return false;
      const byId = new Map(
        [...older.messages, ...latest.messages].map((view) => [
          String(view.message.id),
          view,
        ]),
      );
      const messages = [...byId.values()].sort(
        (left, right) => left.message.sequence - right.message.sequence,
      );
      if (this.disposed) return false;
      this.emit({
        histories: {
          ...this.state.histories,
          [conversationId]: {
            thread: latest.thread,
            messages,
            olderCursor: older.olderCursor,
            hasOlderMessages: older.hasOlderMessages,
            // Branch-head metadata is complete for the conversation, not for
            // the page window. Keep a newer refresh authoritative when an
            // older request resolves after it.
            branchHeads: latest.branchHeads ?? older.branchHeads,
          },
        },
      });
      return true;
    }).finally(() => this.olderReads.delete(conversationId));
    this.olderReads.set(conversationId, pending);
    return pending;
  }
  async stop(id: string, project = false) {
    const affected = new Set(
      this.state.data.work
        .filter((work) => (project ? work.projectId === id : work.id === id))
        .map((work) => work.id),
    );
    let size = -1;
    while (size !== affected.size) {
      size = affected.size;
      for (const work of this.state.data.work)
        if (work.parentId && affected.has(work.parentId)) affected.add(work.id);
    }
    for (const key of affected) this.stopping.add(key);
    const sessions = this.state.sessions.filter((session) =>
      affected.has(session.work.id),
    );
    for (const session of sessions) session.cancelled = true;
    this.emit();
    // Freeze streams and revoke computer control immediately, then flush the
    // already accepted checkpoint before invalidating native generations.
    const cancelled = await Promise.allSettled([
      ...sessions.map((session) => session.cancel?.()),
      ...[...this.external]
        .filter(([key]) => affected.has(key))
        .map(([, cancel]) => cancel()),
    ]);
    try {
      await this.command(
        project
          ? { action: "stop-project", projectId: id }
          : { action: "stop-work", id },
      );
    } finally {
      for (const key of affected) this.stopping.delete(key);
    }
    const failure = cancelled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") this.report(failure.reason);
  }
  /** Freeze like Stop, then native generation-fenced `stop-work` immediately. */
  dispose() {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = this.closeOwnedExecution();
    return this.closing;
  }
  private async closeOwnedExecution() {
    const targets = this.executingWork().filter((work) => work.executionOwner !== "native-background").map((work) => ({
      id: work.id,
      expectedGeneration: work.generation,
    }));
    for (const { id } of targets) this.stopping.add(id);
    for (const session of this.state.sessions) session.cancelled = true;
    const nativeStop = (async () => {
      for (const target of targets) {
        try {
          await this.transport.command(this.workspaceId, {
            action: "stop-work",
            id: target.id,
            expectedGeneration: target.expectedGeneration,
          });
        } catch {
          /* remount recovery fences leftover executing Work */
        }
      }
    })();
    await Promise.allSettled([
      ...this.state.sessions.map((session) => session.cancel?.()),
      ...[...this.external.values()].map((cancel) => cancel()),
      nativeStop,
    ]);
    await this.tail.catch(() => undefined);
    await nativeStop;
    this.external.clear();
    for (const [id, scheduled] of this.scheduled)
      scheduled.finish({
        terminal: "interrupted",
        threadId:
          this.state.data.work.find((work) => work.id === id)?.conversationId ??
          "",
        message:
          "The workspace closed. Review saved outcomes before continuing.",
      });
    this.scheduled.clear();
    this.approvals.cancelPending();
    this.listeners.clear();
    this.attachments.clear();
    this.effortAttachments.clear();
    for (const { id } of targets) this.stopping.delete(id);
  }
}

/** Serialize dispose across a pending unmount so remount recovery waits. */
export function enqueueWorkspaceDispose(
  previous: Promise<unknown>,
  service: { dispose(): Promise<void> | void } | null | undefined,
): Promise<void> {
  const settled = Promise.resolve(previous).then(
    () => undefined,
    () => undefined,
  );
  if (!service) return settled;
  return settled
    .then(() => Promise.resolve(service.dispose()))
    .then(
      () => undefined,
      () => undefined,
    );
}
