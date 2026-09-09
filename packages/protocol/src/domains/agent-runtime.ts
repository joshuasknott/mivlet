import type {
  ApprovalAuditEntry,
  ApprovalRequest,
  ApprovalRiskLevel,
  PermissionMode,
} from "./approvals.js";
import type {
  InternalUserId,
  MemberId,
  WorkspaceId,
} from "../spine/primitives.js";
import type { ProviderRouteSelection } from "./provider-routing.js";

export type ExecutionAttemptStatus =
  | "queued"
  | "streaming"
  | "awaiting-approval"
  | "retrying"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface ExecutionExchange {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  ok?: boolean;
  /** Durable metadata only. User image pixels remain ephemeral and must be reattached. */
  images?: ExecutionImageMetadata[];
}

export type NativeImageMediaType = "image/png" | "image/jpeg" | "image/webp";

/** Non-secret metadata safe to retain in an execution checkpoint. */
export interface ExecutionImageMetadata {
  id: string;
  name: string;
  mediaType: NativeImageMediaType;
  sizeBytes: number;
  width: number;
  height: number;
}

/** Transient user image supplied to one provider turn. Never persist `dataUrl`. */
export interface NativeImageInput extends ExecutionImageMetadata {
  dataUrl: string;
}

/** Stable, user-visible reason an item entered a turn's bounded context. */
export type ExecutionContextContributionReason =
  | "system-instruction"
  | "conversation"
  | "pinned"
  | "memory-approved"
  | "memory-pinned"
  | "retrieved"
  | "tool-result";

export interface ExecutionContextContribution {
  id: string;
  kind: "memory" | "source" | "tool-result" | "conversation" | "instruction";
  reason: ExecutionContextContributionReason;
  citationId?: string;
}

/** Scope snapshot used for one execution attempt. */
export interface ExecutionContextScope {
  level: "global" | "thread";
  threadId?: string;
}

/** Portable access boundary for Knowledge and Memory records. */
export type ContextPrivateOwner =
  | { ownerMemberId: MemberId; ownerInternalUserId?: never }
  | { ownerInternalUserId: InternalUserId; ownerMemberId?: never };

export type ContextRecordAuthorityScope =
  | ({
      authority: "local";
      visibility: "member-private";
    } & ContextPrivateOwner)
  | {
      authority: "convex";
      visibility: "workspace-shared";
      ownerMemberId?: never;
      ownerInternalUserId?: never;
    };

/** Audience the context was assembled for; it never expands record authority. */
export type ExecutionContextAudience =
  | ({
      authority: "local";
      visibility: "member-private";
    } & (
      | { actingMemberId: MemberId; actingInternalUserId?: never }
      | { actingInternalUserId: InternalUserId; actingMemberId?: never }
    ))
  | {
      authority: "convex";
      visibility: "workspace-shared";
      actingMemberId: MemberId;
      actingInternalUserId?: never;
    };

/** Immutable citation snapshot: later source changes cannot rewrite evidence. */
export interface ExecutionContextCitation {
  sourceId: string;
  title: string;
  snippet: string;
  provenance: string;
  freshness: string;
  trust: "trusted" | "untrusted";
  pinned: boolean;
  score: number;
  chunkId?: string;
  account?: string;
  ranking: {
    relevance: number;
    recency: number;
    authority: number;
    pin: number;
    feedback: number;
  };
  sourcePath?: string;
  mediaType?: string;
  scope?: ExecutionContextScope;
  /** Access facts snapshotted from the authorized source. */
  authorityScope?: ContextRecordAuthorityScope;
}

/**
 * Non-secret evidence captured before provider egress. It records what bounded
 * context was selected and why, without storing hidden reasoning.
 */
export interface ExecutionContextReceiptV1 {
  version: 1;
  attemptId: string;
  assembledAt: string;
  scope: ExecutionContextScope;
  citations: ExecutionContextCitation[];
  contributions: ExecutionContextContribution[];
}

export interface ExecutionContextReceiptV2 {
  version: 2;
  attemptId: string;
  assembledAt: string;
  scope: ExecutionContextScope;
  audience: ExecutionContextAudience;
  citations: ExecutionContextCitation[];
  contributions: ExecutionContextContribution[];
}

export type ExecutionContextReceipt =
  ExecutionContextReceiptV1 | ExecutionContextReceiptV2;

/** Transient prepared context handed to the execution boundary before egress. */
export interface PreparedExecutionContext {
  systemPrefix: string;
  receipt: ExecutionContextReceipt;
}

/** Minimal durable checkpoint for one provider-backed conversation turn. */
export interface ExecutionAttempt {
  id: string;
  providerId: string;
  model: string;
  status: ExecutionAttemptStatus;
  transcript: string;
  /** Public provider-supplied summaries; never private chain-of-thought. */
  reasoningSummaries?: Record<string, string>;
  /** Active chat thread this exchange belongs to. */
  threadId?: string;
  /** Durable completed/checkpointed user, assistant, and tool exchanges. */
  exchanges?: ExecutionExchange[];
  /** Prior interrupted/failed attempt when this is an explicit retry. */
  parentAttemptId?: string;
  /** Immutable bounded-context evidence captured before provider egress. */
  contextReceipt?: ExecutionContextReceipt;
  /** Exact portable provider route selected before native provider egress. */
  providerRoute?: ProviderRouteExecutionBinding;
  turn: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costEstimated?: boolean;
    costUnknown?: boolean;
  };
  pendingApprovalIds: string[];
  recoverable: boolean;
  retryCount: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The transport a backend speaks. Codex reaches its app-server, while native
 * API providers speak their HTTP/SSE APIs directly with Fable owning the loop.
 */
export type BackendType =
  | "codex-app-server"
  | "claude-agent"
  | "cursor-acp"
  | "grok-acp"
  | "opencode-server"
  | "antigravity-acp"
  | "native-api";

/**
 * The implementation that owns a provider instance. Driver identity is kept
 * separate from the instance id so a later multi-account instance can be
 * added without changing thread routing or inventing another backend type.
 */
export type ProviderDriverKind =
  | "codex"
  | "claude-agent"
  | "cursor-acp"
  | "grok-acp"
  | "opencode"
  | "antigravity-acp"
  | "native-api";

export type ProviderSetupKind =
  | "browser"
  | "provider-cli"
  | "api-key"
  | "custom";

export interface ProviderSetup {
  kind: ProviderSetupKind;
  label: string;
  description: string;
  recommended: boolean;
}

/**
 * Resolved auth state for a backend instance. Fail-closed states declare no
 * capabilities the adapter cannot honor.
 *
 *   - `connected` — credential/runtime present and last-known good.
 *   - `needs-auth` — an API-key provider awaiting a key.
 *   - `sign-in-required` — the official Codex browser sign-in is required.
 *   - `install-required` — the official Codex runtime components are missing.
 *   - `connecting` — a verification round-trip is in flight (UI-only; never
 *     persisted by the boundary).
 *   - `expired` — a credential/login was valid before but is no longer.
 *   - `unsupported` — the provider cannot be driven from this build (e.g. an
 *     adapter family with no runnable implementation here).
 *   - `failed` — the last verification round-trip failed (transient/offline);
 *     the credential may still be stored, so the user can retry.
 *   - `ready` — terminal success alias surfaced by onboarding before the
 *     boundary re-resolves to `connected`.
 *   - `unavailable` — unknown/initialization failure; fails closed.
 */
export type BackendAuthState =
  | "connected"
  | "needs-auth"
  | "sign-in-required"
  | "install-required"
  | "connecting"
  | "expired"
  | "unsupported"
  | "failed"
  | "ready"
  | "unavailable";

/**
 * States where the backend cannot serve any request (declares no caps). Every
 * {@link BackendAuthState} except `connected` is fail-closed. The union of this
 * list and `"connected"` must equal the full `BackendAuthState` vocabulary —
 * this parity is asserted by `BACKEND_AUTH_STATE_PARITY` below so a duplicate or
 * stray state is caught here rather than drifting into the Rust boundary.
 */
export const BACKEND_AUTH_FAIL_CLOSED_STATES = [
  "needs-auth",
  "sign-in-required",
  "install-required",
  "connecting",
  "expired",
  "unsupported",
  "failed",
  "ready",
  "unavailable",
] as const;

/**
 * Compile-time + runtime closed-vocabulary parity for backend auth states.
 *
 * `BACKEND_AUTH_STATE_VALUES` is the exhaustive, duplicate-free list of every
 * `BackendAuthState`. `BACKEND_AUTH_STATE_PARITY` asserts the fail-closed set
 * plus `"connected"` exactly covers the vocabulary (no missing state, no stray
 * or duplicate value). A `const` assertion of an object whose keys span the
 * union makes a missing/duplicate state a *type* error; the runtime check makes
 * a parity drift between this list and `BACKEND_AUTH_FAIL_CLOSED_STATES` a load-
 * time failure instead of silent dedupe. Mirrors `BACKEND_AUTH_STATES` in the
 * Rust `models.rs` vocabulary (10 distinct values).
 */
export const BACKEND_AUTH_STATE_VALUES = [
  "connected",
  "needs-auth",
  "sign-in-required",
  "install-required",
  "connecting",
  "expired",
  "unsupported",
  "failed",
  "ready",
  "unavailable",
] as const;

// Type-level exhaustiveness: every value must map to a BackendAuthState member.
const _BACKEND_AUTH_STATE_EXHAUSTIVE: Record<BackendAuthState, true> = {
  connected: true,
  "needs-auth": true,
  "sign-in-required": true,
  "install-required": true,
  connecting: true,
  expired: true,
  unsupported: true,
  failed: true,
  ready: true,
  unavailable: true,
};

// Runtime parity: fail-closed ∪ {connected} must equal the vocabulary exactly.
const _BACKEND_AUTH_STATE_PARITY_CHECK = (() => {
  const expected = new Set<string>(BACKEND_AUTH_STATE_VALUES);
  const actual = new Set<string>([
    ...BACKEND_AUTH_FAIL_CLOSED_STATES,
    "connected",
  ]);
  if (expected.size !== BACKEND_AUTH_STATE_VALUES.length) {
    throw new Error(
      "BACKEND_AUTH_STATE_VALUES contains a duplicate auth state.",
    );
  }
  if (expected.size !== actual.size) {
    throw new Error(
      "Backend auth-state vocabulary has drifted from the fail-closed set.",
    );
  }
  for (const state of actual) {
    if (!expected.has(state)) {
      throw new Error(
        `Backend auth-state "${state}" is not in the vocabulary.`,
      );
    }
  }
  return true as const;
})();
export const BACKEND_AUTH_STATE_PARITY = _BACKEND_AUTH_STATE_PARITY_CHECK;
void _BACKEND_AUTH_STATE_EXHAUSTIVE;

/**
 * The closed capability set an adapter may declare dynamically. The UI may
 * only render a control for a capability the adapter actually reported.
 */
export type BackendCapability =
  | "authentication"
  | "threads"
  | "streaming"
  | "tool-requests"
  | "approvals"
  | "file-changes"
  | "usage-cost"
  | "model-availability"
  | "cancellation";

/**
 * The closed set of per-model capabilities Fable represents. Each field is a
 * truthful ceiling: it is only present when the adapter (or curated catalogue)
 * actually knows the model can honor it. An adapter must never populate a field
 * it cannot back — unknown capabilities stay `undefined` on the model, never
 * fabricated.
 */
export interface ModelCapabilities {
  /** Total input + output token ceiling for the model's context window. */
  contextWindow: number;
  /** Provider-imposed output cap for a single completion (max_tokens ceiling). */
  maxOutputTokens: number;
  /** Model supports streamed (SSE) completions. */
  streaming: boolean;
  /** Model supports tool / function calling. */
  tools: boolean;
  /** Model accepts image / vision inputs. */
  vision: boolean;
  /** Model exposes an internal reasoning / thinking mode. */
  reasoning: boolean;
  /** Model supports structured / JSON-schema-constrained output. */
  structuredOutput: boolean;
}

/** A selectable model exposed by a backend. */
export interface BackendModel {
  id: string;
  label: string;
  available: boolean;
  /**
   * Per-model capabilities. Optional: present only when the adapter or curated
   * catalogue knows them. Callers must treat `undefined` as "capabilities
   * unknown" (fail conservatively), never as "all capabilities present".
   */
  capabilities?: Partial<ModelCapabilities>;
  /** Only levels advertised by this runtime or verified for this exact model. */
  reasoning?: {
    supportedEfforts: string[];
    defaultEffort?: string;
  };
}

/**
 * Describes a connected (or connectable) agent-runtime backend. Capabilities
 * and entitlements are resolved dynamically from the current auth state —
 * adapters must never fake a capability they lack.
 */
export interface BackendProvider {
  id: string;
  /** Stable configured instance id. Omitted only by older persisted/fixture payloads. */
  instanceId?: string;
  /** Runtime implementation selected independently of the instance id. */
  driverKind?: ProviderDriverKind;
  backendType: BackendType;
  label: string;
  description: string;
  authState: BackendAuthState;
  capabilities: BackendCapability[];
  models: BackendModel[];
  /** Setup presentation. Optional only for cross-version payload compatibility. */
  setup?: ProviderSetup;
  /** Shown when `authState === "install-required"` (e.g. a missing CLI). */
  installHint?: string;
  /**
   * Entitlements detected post-login only. Grok Build is never promised for any
   * tier in fixture/preview data — it only appears here after a real check.
   */
  entitlements?: string[];
}

/**
 * Request to store a backend credential. The secret is handed to the Rust
 * credential boundary and never read back into JavaScript.
 */
export interface BackendCredentialRequest {
  providerId: string;
  secret: string;
}

/**
 * Outcome of verifying a stored backend credential against the provider. Rust
 * hit-tests the stored key inside the credential boundary (no key crosses to
 * JS) and returns one of these outcomes. Custom OpenAI-compatible endpoints
 * can be `configured` when their validated settings are saved but the endpoint
 * has not yet been exercised. `auth-failed` clears the bad key; the transient
 * outcomes keep the stored key so the user can retry.
 */
export type BackendVerifyOutcome =
  "ready" | "configured" | "auth-failed" | "offline" | "unsupported" | "failed";

export interface BackendVerifyResult {
  providerId: string;
  outcome: BackendVerifyOutcome;
  /** Optional human-readable detail for surfacing useful errors. */
  message?: string;
}

/**
 * A consequential action a backend wants to perform (tool call, file write,
 * shell command). Fable routes these into its existing ApprovalRequest system
 * rather than letting the backend execute them directly.
 */
export interface BackendConsequentialEvent {
  providerId: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  /** When the backend already approved this internally, record it as audit. */
  backendPreapproved?: boolean;
}

/** An audit entry recording a backend-originated action. */
export interface BackendEventAudit {
  providerId: string;
  auditEntry: ApprovalAuditEntry;
}

// ---------------------------------------------------------------------------
// Native-API agent loop: events + request shaping.
//
// The TypeScript layer owns request/response shaping + the agent loop as pure,
// fixture-testable logic; the Rust boundary owns the API key + HTTP/SSE egress.
// The API key NEVER appears in any of these types — it is added as an
// Authorization/x-api-key/x-goog-api-key header inside Rust only.
// ---------------------------------------------------------------------------

/** A message role in the normalized conversation. */
export type NativeMessageRole = "system" | "user" | "assistant" | "tool";

/** A single conversation message. `toolCallId` pairs a tool result to its call. */
export interface NativeMessage {
  role: NativeMessageRole;
  content: string;
  /** Only current user input may carry transient image pixels. */
  images?: NativeImageInput[];
  /** Assistant tool calls, when role === "assistant" and the model requested tools. */
  toolCalls?: NativeToolCall[];
  /** Tool-result call id, when role === "tool". */
  toolCallId?: string;
  /** Tool name for providers (for example Gemini) that require it on results. */
  toolName?: string;
}

/** A tool call the model emitted. The arguments are the raw model JSON string. */
export interface NativeToolCall {
  callId: string;
  tool: string;
  arguments: string;
}

/** A tool the loop advertises to the model (Fable-owned, from the registry). */
export interface NativeToolSpec {
  name: string;
  description: string;
  /** JSON-schema parameter shape, serialized as a string for transport. */
  parameters: string;
}

/** An Fable-owned tool the native loop may dispatch after approval. */
export interface BackendTool {
  name: string;
  description: string;
  defaultMode: PermissionMode;
  defaultRisk: ApprovalRiskLevel;
  parameters: string;
}

/** Normalized completion request the loop shapes per provider. No key, no URL. */
export interface NativeCompletionRequest {
  providerId: string;
  model: string;
  reasoningEffort?: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  /** Max output tokens; provider shapers clamp to the provider's limit. */
  maxTokens: number;
  /** Exact portable route binding for an ordinary native provider run. */
  providerRoute?: ProviderRouteExecutionBinding;
}

/** Workspace-fenced route authority carried unchanged from selection to egress. */
export interface ProviderRouteExecutionBinding {
  workspaceId: WorkspaceId;
  selection: ProviderRouteSelection;
}

/**
 * A normalized agent-loop event streamed back to the shell — the shared event
 * surface for the native-API loop. Model tool calls arrive as `tool-call`
 * carrying a pre-shaped ApprovalRequest so they route through Fable's existing
 * approval queue before the tool is executed.
 */
export type BackendAgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-summary"; text: string; itemId: string; summaryIndex: number }
  | {
      /** Provider-owned read activity that never enters Fable's approval/execution gate. */
      type: "provider-tool";
      callId: string;
      tool: string;
      arguments: string;
      status: "running" | "succeeded" | "failed";
      output?: string;
    }
  | {
      type: "tool-call";
      callId: string;
      tool: string;
      arguments: string;
      approval: ApprovalRequest;
    }
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      costEstimated?: boolean;
      /** True when the provider supplied no cost and Fable has no trusted rate. */
      costUnknown?: boolean;
    }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | {
      type: "error";
      message: string;
      /**
       * Machine-readable error code for routing (e.g. "authentication" routes a
       * background attempt to blocked-auth). Optional: backends that can't classify
       * leave it undefined and callers treat it as a generic failure.
       */
      code?: string;
      /** True when the failure is transient and a retry may succeed. */
      retryable?: boolean;
    }
  | { type: "cancelled" };

// ---------------------------------------------------------------------------
// Provider-neutral AgentBackend runtime contract.
//
// BackendAgentEvent (above) is the universal streaming surface every backend
// family speaks. The AgentBackend abstraction lets native API and Codex
// app-server implement one contract: run a prompt turn (streaming events),
// request tools/approvals, cancel, and expose models/capabilities. Backends
// without a live adapter fail closed.
//
// HARD SECRET INVARIANT: none of these types carry a key, token, or credential.
// Auth lives behind the Rust boundary or a provider-owned auth cache. An
// AgentBackend instance must never hold a secret in its fields.
// ---------------------------------------------------------------------------

/**
 * A normalized prompt turn for any agent backend. Shaped like the existing
 * key-free {@link NativeCompletionRequest}; carries NO key, NO token, NO URL.
 * Backend-specific shaping happens inside the adapter, never in this type.
 */
export interface AgentTurnRequest {
  model: string;
  reasoningEffort?: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  /** Max output tokens; adapters clamp to the model's known ceiling. */
  maxTokens: number;
  providerRoute?: ProviderRouteExecutionBinding;
}

/**
 * Options for one agent turn. Provider-neutral: the execute/shouldCancel/approval
 * seams are the same ones the native-API loop uses, so any backend that issues
 * tool calls routes through Fable's shared approval queue.
 */
export interface AgentTurnOptions {
  /** Executes an approved tool. Backends call this for each tool-call event. */
  execute: (approval: ApprovalRequest, args: string) => Promise<string>;
  /** Grants or denies a provider-owned action without executing it twice in Fable. */
  authorize?: (approval: ApprovalRequest) => Promise<void>;
  /** Cooperative cancellation hook, checked between events. */
  shouldCancel?: () => boolean;
  /** Optional system-context prefix (pinned memory/knowledge by trust level). */
  contextPrefix?: string;
  /** The composer's permission level, gating which tools may execute. */
  permissionMode?: PermissionMode;
  /** Stable attempt id used to bind approvals and reject replayed calls. */
  attemptId?: string;
  /** Exact local computer scope; native authority validates it independently. */
  computer?: { workspaceId: string; agentId: string };
  /** Max turns before the backend stops (safety). */
  maxTurns?: number;
  /** Maximum accepted tool calls across the whole run. */
  maxToolCalls?: number;
  /** Maximum characters returned to model context by one tool. */
  maxToolOutputCharacters?: number;
  /**
   * Notifies the shell that the backend's transport is retrying after a
   * transient failure (e.g. HTTP 429/5xx backoff). Provider-neutral: any
   * egress-bound backend may retry. The shell uses this to mark the persisted
   * attempt as "retrying" and bump its retry count.
   */
  onRetry?: () => void;
}
