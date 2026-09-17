import type {
  BackendProvider,
  CollaborationCommand,
  CollaborationSnapshot,
  CollaborationWorkItem,
  FableAgentProfile,
  PermissionMode,
  WorkAttachment,
} from "@fable/protocol";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import type { ComposerAttachment } from "./types";
import {
  commandCollaboration,
  loadCollaboration,
} from "../runtime/domains/collaboration";
import { loadDesktopConversation } from "../hooks/useDurableConversation";
import type { HydratedConversation } from "./conversation-runtime";
import {
  resolveProviderModelOption,
  type ProviderModelOption,
} from "./provider-models";
import { ExecutionApprovalRouter } from "./execution-approvals";

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
  profile: FableAgentProfile;
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
  private attachments = new Map<string, ComposerAttachment[]>();
  private stopping = new Set<string>();
  private external = new Map<string, () => Promise<void>>();
  private disposed = false;
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
  private accept(data: CollaborationSnapshot) {
    if (this.disposed) return;
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
    return this.command({ action: "steer-work", id, expectedGeneration, eventId: crypto.randomUUID(), text });
  }
  async submit(
    conversationId: string,
    agentId: string,
    prompt: string,
    discussion: boolean,
    attachments: ComposerAttachment[],
  ) {
    const id = `work-${crypto.randomUUID()}`;
    this.attachments.set(id, [...attachments]);
    try {
      await this.command({
        action: "start-work",
        id,
        conversationId,
        agentId,
        prompt,
        discussion,
        attachments: composerAttachmentRefs(attachments),
      });
      return id;
    } catch (error) {
      this.attachments.delete(id);
      throw error;
    }
  }
  /** Conservative app limits; native providers and the computer lease still arbitrate resources. */
  admit(
    profiles: FableAgentProfile[],
    models: ProviderModelOption[],
    providers: BackendProvider[],
    permissionMode: PermissionMode,
  ) {
    if (this.disposed || this.state.loading) return;
    const sessions = [...this.state.sessions];
    let changed = false;
    for (const work of this.state.data.work.filter(
      (work) => work.status === "queued",
    )) {
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
        profile: { ...profile },
        model,
        permissionMode: restrictedPermission(
          permissionMode,
          work.permissionMode,
        ),
        attachments: this.attachments.get(work.id) ?? [],
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
    // Keep inputs for a same-session retry that failed before a durable run.
    // A bound run has already persisted its attachment metadata and context.
    if (this.state.data.work.find(work => work.id === session.work.id)?.runIds.length) this.attachments.delete(session.work.id);
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
    const read = loadDesktopConversation(conversationId)
      .then((history) => {
        if (history && history.thread.id !== conversationId)
          throw new Error("Conversation history scope mismatch.");
        this.emit({
          histories: { ...this.state.histories, [conversationId]: history },
        });
      })
      .finally(() => this.reads.delete(conversationId));
    this.reads.set(conversationId, read);
    return read;
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
  dispose() {
    this.disposed = true;
    for (const cancel of this.external.values())
      void cancel().catch(() => undefined);
    this.external.clear();
    for (const session of this.state.sessions) {
      session.cancelled = true;
      void session.cancel?.().catch(() => undefined);
    }
    this.approvals.cancelPending();
    this.listeners.clear();
    this.attachments.clear();
  }
}
