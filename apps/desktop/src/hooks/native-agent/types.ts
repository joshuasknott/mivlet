import type {
  ApprovalRequest,
  BackendAgentEvent,
  BackendModel,
  BackendProvider,
  ExecutionAttempt,
  ExecutionContextReceipt,
  ProviderRouteExecutionBinding,
  Spine,
} from "@mivlet/protocol";
import type { ToolExecutor } from "@mivlet/connectors";
import type { ConversationContextFailure } from "../../lib/conversation-context";
import type {
  DurableRunWriter,
  HydratedConversation,
} from "../../lib/conversation-runtime";
import type { ResponsePart } from "../../lib/conversation-presentation";

export interface NativeAgentState {
  transcript: string;
  responseParts?: ResponsePart[];
  progressPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  progressThreadId?: string;
  reasoningSummaries?: Record<string, string>;
  progressReceipts?: Record<
    string,
    { summaries: Record<string, string>; startedAt: string; endedAt: string }
  >;
  activity?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costEstimated?: boolean;
    costUnknown?: boolean;
  } | null;
  running: boolean;
  /** Immediate presentation fence while the existing durable Stop finishes. */
  stopRequested?: boolean;
  lastError: string | null;
  contextFailure?: ConversationContextFailure & {
    requestPrompt: string;
    scope: NativeAgentContextScope;
  };
  status: ExecutionAttempt["status"] | "idle";
  recoverableAttempts: ExecutionAttempt[];
  /** Immutable context evidence keyed by canonical attempt id, including recovered completed attempts. */
  contextReceipts: Record<string, ExecutionContextReceipt>;
  /** Secret-free durable provider route evidence keyed by canonical attempt id. */
  providerRoutes: Record<string, ProviderRouteExecutionBinding>;
  /** Final provider usage keyed by canonical attempt id, including restarted history. */
  usageReceipts: Record<string, NonNullable<ExecutionAttempt["usage"]>>;
  /** Canonical id for the current or most recently started attempt. */
  currentAttemptId: string | null;
  /** Agent scope for the visible progress fields; prevents old work leaking after navigation. */
  progressAgentId?: string;
  /** True when there is no desktop runtime to carry the request. */
  noTransport: boolean;
}

export interface NativeAgentContextScope {
  workspaceId?: string;
  agentId?: string;
  threadId?: string;
  ownerInternalUserId?: string;
  ownerMemberId?: string;
}

export interface UseNativeAgentOptions {
  /** App-owned workers must never recover journals when a view or worker mounts. */
  recover?: boolean;
  /** Public assistant contributions can be labelled without turning them into user authority. */
  attributeHistory?: (conversation: HydratedConversation) => HydratedConversation;
  computer?: { workspaceId: string; agentId: string };
  contextOwner?: { internalUserId: string; memberId?: string };
  providers: BackendProvider[];
  /** Provider selected by the combined model picker. */
  activeProviderId?: string;
  /** Truthfully selectable models after dynamic discovery/catalogue merging. */
  models?: BackendModel[];
  /** Active chat/thread identifier used to durably associate completed exchanges. */
  threadId?: string;
  /** Fresh canonical history; never re-persisted as a new user turn. */
  loadConversation?: (threadId: string) => Promise<HydratedConversation | null>;
  /** Receives tool-call events so the shell can route them into its approval queue. */
  onToolCall?: (
    event: Extract<BackendAgentEvent, { type: "tool-call" }>,
  ) => void;
  /**
   * The real tool executor, wired to the shell's shared approval gate + the Rust
   * boundary. When omitted the loop uses a fail-closed stub (tool calls surface
   * as approvals and execution refuses) — this is the pre-tool-execution behavior
   * and keeps the hook fixture-testable without a live approval gate.
   */
  execute?: ToolExecutor;
  /** Approval-only gate for provider-owned tools such as Antigravity ACP. */
  authorize?: (approval: ApprovalRequest) => Promise<void>;
  /**
   * Cooperative cancellation hook, checked between events. When omitted the loop
   * can never be cooperatively cancelled mid-turn (real in-flight cancellation
   * still happens at the Rust boundary via cancel()). App.tsx wires this to a
   * cancel flag so an in-flight loop can bail between events.
   */
  shouldCancel?: () => boolean;
  /**
   * Invoked once when an attempt is cancelled, so the shell can tear down any
   * tool-call still awaiting approval on the shared gate (gate.cancelPending()).
   * This prevents cancelled-but-never-granted calls (and their unresolved
   * promises) from lingering for the session. Cooperative cancel + the Rust
   * boundary drop stay intact — this is the gate-teardown layer on top.
   */
  onCancel?: () => void;
  /**
   * Optional canonical transcript writer. The legacy run remains an in-flight
   * recovery adapter; when a durable thread is active, lifecycle facts flow to
   * this writer with stable per-run idempotency keys.
   */
  createDurableRunWriter?: (
    threadId: string,
    attemptId: string,
  ) => DurableRunWriter;
}

export interface NativeAgentRunControl {
  /** Confirmed assistant text only, after its durable checkpoint; never reasoning. */
  onTextDelta?: (text: string) => void;
  maxTurns?: number;
  /**
   * Runs after the queued execution journal exists, before canonical user
   * persistence or provider egress. Project execution uses this boundary to
   * bind the attempt to its native author authority.
   */
  afterAttemptQueued?: (context: {
    attemptId: string;
    threadId: string | undefined;
  }) => void | Promise<void>;
  /** Suppress only the canonical user record for an internal contribution. */
  canonicalUserMessage?: "persist" | "suppress";
  /** Safe metadata for the exact attachments captured by this submitted turn. */
  attachments?: readonly Spine.Conversations.ConversationAttachmentMetadata[];
}

