/**
 * Pure helpers that build the agent-loop inputs from shell state, so the
 * composer's model/permission pickers + pinned memory/knowledge drive the real
 * agent run instead of staying decorative local state.
 *
 * Kept pure (no React, no transport) so they can be unit-tested directly and
 * asserted against a fake transport at the integration seam.
 */

import type {
  AccountWorkspaceStatus,
  AgentTurnRequest,
  ApprovalPresetLabel,
  BackendModel,
  ContextRecordAuthorityScope,
  KnowledgeScope,
  KnowledgeSource,
  MemoryRecord,
  PermissionMode,
  ExecutionContextAudience,
  Spine
} from "@fable/protocol";
import { buildContextPrefix } from "@fable/connectors/native-api/memory-context";
import {
  MAX_TOKENS_DEFAULT,
  validateModelForRun
} from "@fable/connectors/native-api/model-catalogue";
import { authorityScopeAllowsAudience } from "@fable/knowledge";

/**
 * The composer's approval picker uses simple user-facing labels. These map
 * onto the protocol's internal PermissionMode vocabulary so the agent run can
 * constrain tool approvals without exposing implementation terms.
 */
export interface PermissionProfile {
  label: ApprovalPresetLabel;
  description: string;
  mode: PermissionMode;
  custom?: boolean;
}

export const PERMISSION_PROFILES: readonly PermissionProfile[] = [
  {
    label: "Read Only",
    description: "Fable can look, summarize, search, and review, but cannot change anything.",
    mode: "read-only"
  },
  {
    label: "Ask Me",
    description: "Fable asks before making changes or taking external actions.",
    mode: "trusted-scope"
  },
  {
    label: "Work Freely",
    description: "Fable handles everyday work, but asks before risky actions.",
    mode: "full-access"
  },
  {
    label: "Custom",
    description: "Choose simple approval preferences.",
    mode: "trusted-scope",
    custom: true
  }
];

export const DEFAULT_PERMISSION_LABEL: ApprovalPresetLabel = "Ask Me";

/** The PermissionMode for a composer approval label. Default = Ask Me. */
export function permissionModeFor(label: string): PermissionMode {
  return PERMISSION_PROFILES.find((profile) => profile.label === label)?.mode ?? "trusted-scope";
}

/** The primary composer label for a PermissionMode. Custom is preserved separately. */
export function permissionLabelFor(mode: PermissionMode): ApprovalPresetLabel {
  return (
    PERMISSION_PROFILES.find((profile) => profile.mode === mode && !profile.custom)?.label ??
    DEFAULT_PERMISSION_LABEL
  );
}

/** The plain description for a PermissionMode, surfaced wherever a profile is shown. */
export function permissionDescriptionFor(mode: PermissionMode): string {
  return (
    PERMISSION_PROFILES.find((profile) => profile.mode === mode && !profile.custom)?.description ??
    PERMISSION_PROFILES.find((profile) => profile.label === DEFAULT_PERMISSION_LABEL)!.description
  );
}

export function isApprovalPresetLabel(value: string): value is ApprovalPresetLabel {
  return PERMISSION_PROFILES.some((profile) => profile.label === value);
}

export const APPROVAL_BANNED_JARGON = [
  "sandbox",
  "egress",
  "mcp",
  "execution policy",
  "permission graph",
  "token",
  "credential"
] as const;

export function findApprovalJargon(copy: string): string[] {
  const lower = copy.toLowerCase();
  return APPROVAL_BANNED_JARGON.filter((term) => lower.includes(term));
}

export interface BuildContextPrefixForRunInput {
  memoryRecords: MemoryRecord[];
  knowledgeSources: KnowledgeSource[];
  /** Source ids the user has pinned into workspace context. */
  pinnedSourceIds: string[];
  /** When true, memory is skipped entirely (behavior unchanged). */
  memoryDisabled: boolean;
}

/** Optional agent-level filters applied before retrieval. */
export interface KnowledgeRunContext {
  /** Exact connected accounts this teammate may read from; grants nothing. */
  allowedConnectionIds?: readonly string[];
  /** Connector manifest ids this teammate may read from. */
  allowedConnectorIds?: readonly string[];
  /** Knowledge source ids this teammate may include. */
  allowedKnowledgeSourceIds?: readonly string[];
}

const PRIVATE_CONTEXT_MEMBER_ERROR =
  "Fable could not confirm this installation's private context owner.";

/**
 * Resolve the native-confirmed owner of installation-local private context.
 * Optional account state never changes this audience.
 */
export function privateRunAudience(status: AccountWorkspaceStatus): ExecutionContextAudience {
  const activeLocalId = status.activeWorkspace.localWorkspaceId.trim();
  const owner = status.activeContextOwner;
  if (
    !status.accountBound ||
    status.state !== "ready" ||
    status.activeWorkspace.source !== "local" ||
    !activeLocalId ||
    !owner?.internalUserId.trim()
  ) {
    throw new Error(PRIVATE_CONTEXT_MEMBER_ERROR);
  }
  return owner.memberId
    ? {
        authority: "local",
        visibility: "member-private",
        actingMemberId: owner.memberId as never
      }
    : {
        authority: "local",
        visibility: "member-private",
        actingInternalUserId: owner.internalUserId as never
      };
}

/** Apply the central fail-closed authority contract to run inputs. */
export function recordsVisibleToRunAudience<T extends { authorityScope?: ContextRecordAuthorityScope }>(
  records: readonly T[],
  audience: ExecutionContextAudience
): T[] {
  return records.filter((record) => authorityScopeAllowsAudience(record.authorityScope, audience));
}

/**
 * Browser preview has no native migration boundary, so its explicit fixture
 * records are cloned with the preview user's private authority before use.
 */
export function withPreviewPrivateAuthority<T extends { authorityScope?: ContextRecordAuthorityScope }>(
  records: readonly T[],
  audience: ExecutionContextAudience
): T[] {
  if (audience.authority !== "local" || audience.visibility !== "member-private") {
    throw new Error(PRIVATE_CONTEXT_MEMBER_ERROR);
  }
  let authorityScope: ContextRecordAuthorityScope;
  if (audience.actingMemberId) {
    authorityScope = {
      authority: "local",
      visibility: "member-private",
      ownerMemberId: audience.actingMemberId
    };
  } else if (audience.actingInternalUserId) {
    authorityScope = {
      authority: "local",
      visibility: "member-private",
      ownerInternalUserId: audience.actingInternalUserId
    };
  } else {
    throw new Error(PRIVATE_CONTEXT_MEMBER_ERROR);
  }
  return records.map((record) => ({ ...record, authorityScope }));
}

function isLiveMemoryRecord(record: MemoryRecord) {
  return !record.disabled && !record.forgottenAt;
}

/** Select live workspace memory for one response. */
export function selectMemoryForRun(
  workspaceMemoryRecords: readonly MemoryRecord[]
): MemoryRecord[] {
  return workspaceMemoryRecords.filter(isLiveMemoryRecord);
}

/** Resolve one response to either the active conversation or global workspace. */
export function knowledgeScopeForRun(
  activeThreadId: string | undefined
): KnowledgeScope {
  return activeThreadId
    ? { level: "thread", threadId: activeThreadId }
    : { level: "global" };
}

/** Apply an optional exact Connection allowlist before retrieval. */
export function sourceAllowedByConnections(
  source: Pick<KnowledgeSource, "connectorId" | "connectionId">,
  context?: KnowledgeRunContext
): boolean {
  if (!context?.allowedConnectionIds || source.connectorId === "local-files") return true;
  if (!source.connectionId) return false;
  return context.allowedConnectionIds.includes(source.connectionId);
}

/**
 * Build the system-context prefix the agent loop prepends to its messages.
 *
 * Memory is skipped when disabled. Only pinned memory records and pinned
 * knowledge sources contribute (by trust tier via buildContextPrefix). Returns
 * "" when nothing contributes, so the agent request stays unchanged.
 */
export function buildContextPrefixForRun(input: BuildContextPrefixForRunInput): string {
  // Memory pinning flips record.pinned; source pinning is tracked solely by the
  // pinnedSourceIds set (the shell never mutates source.pinned on merged sources).
  const memory = input.memoryDisabled
    ? []
    : input.memoryRecords.filter(
        (record) => record.pinned && !record.disabled && !record.forgottenAt
      );
  const pinnedIdSet = new Set(input.pinnedSourceIds);
  const sources = input.knowledgeSources.filter(
    (source) =>
      pinnedIdSet.has(source.id) &&
      !source.disabled &&
      !source.deletedAt &&
      source.status !== "stale" &&
      source.status !== "error"
  );
  return buildContextPrefix(memory, sources);
}

export interface BuildAgentRequestInput {
  model: string;
  prompt: string;
  maxTokens?: number;
}

/**
 * Shape the composer submission into a provider-neutral {@link AgentTurnRequest}.
 * The providerId is NOT part of the request: the connected backend owns it (it
 * knows which provider it runs for), so the request carries only the model,
 * messages, tools, and token ceiling.
 */
export function buildAgentRequest(input: BuildAgentRequestInput): AgentTurnRequest {
  return {
    model: input.model,
    messages: [{ role: "user", content: input.prompt }],
    tools: [],
    maxTokens: input.maxTokens ?? MAX_TOKENS_DEFAULT
  };
}

/**
 * Produce only replay-safe context from the canonical transcript. Presentation
 * records (approval/error/interruption) never become model authority, hidden
 * system/context prompts are never stored here, and tool *calls* are excluded
 * because repeating them could suggest replaying a completed side effect.
 */
export function buildContinuationMessages(
  views: readonly {
    message: Spine.Conversations.Message;
    currentRevision: Spine.Conversations.MessageRevision;
  }[]
): AgentTurnRequest["messages"] {
  const messages: AgentTurnRequest["messages"] = [];
  for (const { message, currentRevision } of [...views].sort((left, right) => left.message.sequence - right.message.sequence)) {
    if (currentRevision.state !== "terminal" || !currentRevision.content) continue;
    if (message.kind === "user" || message.kind === "assistant") {
      messages.push({ role: message.kind, content: currentRevision.content });
    } else if (message.kind === "tool" && message.detail.phase === "result") {
      messages.push({ role: "tool", content: currentRevision.content, toolCallId: message.detail.toolCallId, toolName: message.detail.toolName });
    }
  }
  return messages;
}

/**
 * Validate the model selection before a run starts. The shell calls this with
 * the connected provider's selectable models so an unknown/unavailable model —
 * or one whose known capabilities exclude streaming — is caught *before* the
 * run, surfacing a normalized error to the user instead of a provider rejection.
 *
 * Returns the resolved (catalogue/discovery) capabilities and the maxTokens
 * clamped to the model's output ceiling, so the caller can shape the request
 * with truthful limits.
 */
export function validateModelSelection(
  providerId: string,
  modelId: string,
  models: BackendModel[],
  maxTokens?: number
) {
  return validateModelForRun(providerId, modelId, models, maxTokens ?? MAX_TOKENS_DEFAULT);
}

/**
 * Resolve the model id to send. Keeps the persisted selection when it is still
 * available on the connected backend; otherwise falls back to the first
 * available model, or "" when none is available.
 */
export function resolveSelectedModel(
  models: BackendModel[],
  persistedModelId: string
): string {
  if (persistedModelId && models.some((model) => model.id === persistedModelId && model.available)) {
    return persistedModelId;
  }
  return models.find((model) => model.available)?.id ?? "";
}
