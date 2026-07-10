import type { ContractError } from "./missions.js";
import type {
  ConversationTombstoneId,
  DeviceId,
  InternalUserId,
  IsoDateTime,
  MemberId,
  MessageId,
  MessageRevisionId,
  ProjectId,
  Revision,
  RunEventId,
  RunId,
  SchemaVersion,
  ScopedRecordMetadata,
  ThreadId,
  WorkspaceId
} from "./primitives.js";

/** Portable bounds; adapters may impose smaller limits but never larger ones. */
export const THREAD_TITLE_MAX_CHARACTERS = 256;
export const MESSAGE_CONTENT_MAX_CHARACTERS = 262_144;
export const MESSAGE_REVISIONS_MAX_PER_MESSAGE = 1_024;
export const SHARED_MUTATION_DEPENDENCIES_MAX = 64;

export const THREAD_LIFECYCLE_STATES = ["active", "archived"] as const;
export type ThreadLifecycleState = (typeof THREAD_LIFECYCLE_STATES)[number];

/** The complete durable Wave 1B message vocabulary. */
export const MESSAGE_KINDS = [
  "user",
  "assistant",
  "tool",
  "approval",
  "interruption",
  "error"
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_REVISION_STATES = ["streaming", "terminal", "redacted"] as const;
export type MessageRevisionState = (typeof MESSAGE_REVISION_STATES)[number];

export const MESSAGE_REVISION_REASONS = [
  "initial",
  "stream-checkpoint",
  "completion",
  "edit",
  "recovery",
  "redaction"
] as const;
export type MessageRevisionReason = (typeof MESSAGE_REVISION_REASONS)[number];

export const MESSAGE_REDACTION_REASONS = [
  "user-request",
  "policy",
  "retention",
  "security"
] as const;
export type MessageRedactionReason = (typeof MESSAGE_REDACTION_REASONS)[number];

export const TOOL_MESSAGE_PHASES = ["call", "result"] as const;
export type ToolMessagePhase = (typeof TOOL_MESSAGE_PHASES)[number];

export const TOOL_MESSAGE_OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type ToolMessageOutcome = (typeof TOOL_MESSAGE_OUTCOMES)[number];

export const APPROVAL_MESSAGE_PHASES = ["request", "decision"] as const;
export type ApprovalMessagePhase = (typeof APPROVAL_MESSAGE_PHASES)[number];

export const APPROVAL_MESSAGE_DECISIONS = [
  "approved",
  "modified",
  "denied",
  "expired",
  "cancelled"
] as const;
export type ApprovalMessageDecision = (typeof APPROVAL_MESSAGE_DECISIONS)[number];

export const INTERRUPTION_REASONS = [
  "user-stop",
  "provider-disconnected",
  "application-restarted",
  "execution-node-lost",
  "policy-stop",
  "unknown"
] as const;
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number];

export const CONVERSATION_TOMBSTONE_TARGETS = ["thread", "message"] as const;
export type ConversationTombstoneTarget = (typeof CONVERSATION_TOMBSTONE_TARGETS)[number];

export const SHARED_CONVERSATION_MUTATION_OPERATIONS = [
  "thread-create",
  "thread-update",
  "message-append",
  "message-revise",
  "record-delete"
] as const;
export type SharedConversationMutationOperation =
  (typeof SHARED_CONVERSATION_MUTATION_OPERATIONS)[number];

/**
 * Conversation content has exactly two authority modes. Existing local history
 * never becomes shared merely because membership changes.
 */
export type ConversationAuthorityScope =
  | {
      authority: "local";
      visibility: "member-private";
      ownerMemberId: MemberId;
    }
  | {
      authority: "convex";
      visibility: "workspace-shared";
      ownerMemberId?: never;
    };

export type ConversationRecordMetadata = Omit<
  ScopedRecordMetadata,
  "authority" | "visibility" | "ownerMemberId"
> &
  ConversationAuthorityScope;

export interface ThreadMessageHead {
  /** Zero only while the thread contains no messages. */
  lastSequence: number;
  lastMessageId?: MessageId;
}

/** A workspace-owned conversation. Project context is optional and removable. */
export type Thread = Readonly<Omit<ConversationRecordMetadata, "deletedAt">> & {
  readonly deletedAt?: never;
  readonly id: ThreadId;
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly lifecycle: ThreadLifecycleState;
  readonly messageHead: ThreadMessageHead;
};

/** A RunEvent is the execution fact; this link adds no duplicate execution truth. */
export type MessageExecutionLink =
  | { runId: RunId; runEventId?: RunEventId }
  | { runId?: never; runEventId?: never };

export type MessageKindDetail =
  | { kind: "user" | "assistant"; detail?: never }
  | {
      kind: "tool";
      detail:
        | {
            phase: "call";
            toolCallId: string;
            toolName: string;
            outcome?: never;
          }
        | {
            phase: "result";
            toolCallId: string;
            toolName: string;
            outcome: ToolMessageOutcome;
          };
    }
  | {
      kind: "approval";
      detail:
        | {
            phase: "request";
            approvalRequestId: string;
            approvalDecisionId?: never;
            decision?: never;
          }
        | {
            phase: "decision";
            approvalRequestId: string;
            approvalDecisionId: string;
            decision: ApprovalMessageDecision;
          };
    }
  | { kind: "interruption"; detail: { reason: InterruptionReason } }
  | { kind: "error"; detail: { code: string; retryable: boolean } };

/**
 * Stable message identity and thread order. Content lives only in immutable
 * MessageRevision checkpoints. Sequence is strictly monotonic within a thread.
 */
type MessageRecord = Readonly<Omit<ConversationRecordMetadata, "deletedAt">> &
  MessageExecutionLink & {
    readonly deletedAt?: never;
    readonly id: MessageId;
    readonly threadId: ThreadId;
    readonly sequence: number;
    readonly previousMessageId?: MessageId;
    readonly idempotencyKey: string;
    readonly correlationKey?: string;
    readonly currentRevisionId: MessageRevisionId;
    readonly currentRevisionNumber: number;
    readonly currentRevisionState: MessageRevisionState;
  };

export type Message = MessageRecord & Readonly<MessageKindDetail>;

export interface VisibleMessageRevisionBody {
  state: "streaming" | "terminal";
  content: string;
  redaction?: never;
}

export interface RedactedMessageRevisionBody {
  state: "redacted";
  content?: never;
  redaction: {
    reason: MessageRedactionReason;
    note?: string;
  };
}

export type MessageRevisionBody = VisibleMessageRevisionBody | RedactedMessageRevisionBody;

/**
 * Immutable ordered content checkpoint. Revision 1 requires base 0 and no
 * predecessor. Every later revision N requires base N-1 and the exact current
 * predecessor ID; adapters reject stale bases and never merge revision bodies.
 */
export type MessageRevision = Readonly<Omit<ConversationRecordMetadata, "deletedAt">> &
  MessageExecutionLink &
  Readonly<MessageRevisionBody> & {
    readonly deletedAt?: never;
    readonly id: MessageRevisionId;
    readonly messageId: MessageId;
    readonly threadId: ThreadId;
    readonly messageRevisionNumber: number;
    readonly baseMessageRevisionNumber: number;
    readonly previousRevisionId?: MessageRevisionId;
    readonly reason: MessageRevisionReason;
    readonly idempotencyKey: string;
    readonly correlationKey?: string;
    readonly checkpointedAt: IsoDateTime;
  };

export interface ThreadCreateInput {
  authorityScope: ConversationAuthorityScope;
  projectId?: ProjectId;
  title: string;
}

export interface ThreadUpdateInput {
  threadId: ThreadId;
  title?: string;
  lifecycle?: ThreadLifecycleState;
  /** Null explicitly removes project context; omission leaves it unchanged. */
  projectId?: ProjectId | null;
}

export type InitialMessageRevisionInput = MessageExecutionLink &
  MessageRevisionBody & {
    revisionId: MessageRevisionId;
    reason: MessageRevisionReason;
    idempotencyKey: string;
    correlationKey?: string;
    checkpointedAt: IsoDateTime;
  };

export type MessageAppendInput = MessageExecutionLink &
  MessageKindDetail & {
    threadId: ThreadId;
    messageId: MessageId;
    expectedLastSequence: number;
    sequence: number;
    previousMessageId?: MessageId;
    idempotencyKey: string;
    correlationKey?: string;
    initialRevision: InitialMessageRevisionInput;
  };

export type MessageRevisionCreateInput = MessageExecutionLink &
  MessageRevisionBody & {
    threadId: ThreadId;
    messageId: MessageId;
    revisionId: MessageRevisionId;
    baseMessageRevisionNumber: number;
    previousRevisionId?: MessageRevisionId;
    reason: MessageRevisionReason;
    idempotencyKey: string;
    correlationKey?: string;
    checkpointedAt: IsoDateTime;
  };

export interface ConversationDeleteInput {
  target: ConversationTombstoneTarget;
  threadId: ThreadId;
  messageId?: MessageId;
  reason: string;
}

/** Minimal content-free deletion record; stale writes cannot resurrect its target. */
export type ConversationTombstone = Readonly<ConversationRecordMetadata> & {
  readonly id: ConversationTombstoneId;
  readonly target: ConversationTombstoneTarget;
  readonly threadId: ThreadId;
  readonly messageId?: MessageId;
  readonly targetRevision: Revision;
  readonly idempotencyKey: string;
  readonly deletedAt: IsoDateTime;
  readonly reason: string;
};

export interface SharedMutationMetadata {
  workspaceId: WorkspaceId;
  deviceId: DeviceId;
  clientMutationId: string;
  /** Must equal `${workspaceId}:${deviceId}:${clientMutationId}`. */
  idempotencyKey: string;
  /** Exact accepted record revision; zero is reserved for creation. */
  baseRevision: Revision;
  payloadSchemaVersion: SchemaVersion;
  payloadHash: string;
  dependsOnMutationIds: readonly string[];
  requestedByInternalUserId: InternalUserId;
  requestedAt: IsoDateTime;
}

export type SharedConversationMutation =
  | {
      operation: "thread-create";
      metadata: SharedMutationMetadata;
      payload: ThreadCreateInput & { authorityScope: Extract<ConversationAuthorityScope, { authority: "convex" }> };
    }
  | { operation: "thread-update"; metadata: SharedMutationMetadata; payload: ThreadUpdateInput }
  | { operation: "message-append"; metadata: SharedMutationMetadata; payload: MessageAppendInput }
  | {
      operation: "message-revise";
      metadata: SharedMutationMetadata;
      payload: MessageRevisionCreateInput;
    }
  | { operation: "record-delete"; metadata: SharedMutationMetadata; payload: ConversationDeleteInput };

export type SharedConversationMutationResult =
  | {
      status: "accepted";
      replayed: boolean;
      acceptedRecordRevision: Revision;
      acceptedWorkspaceRevision: Revision;
    }
  | { status: "rejected"; error: ContractError };
