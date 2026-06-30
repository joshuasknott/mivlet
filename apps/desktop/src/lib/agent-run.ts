/**
 * Pure helpers that build the agent-loop inputs from shell state, so the
 * composer's model/permission pickers + pinned memory/knowledge drive the real
 * agent run instead of staying decorative local state.
 *
 * Kept pure (no React, no transport) so they can be unit-tested directly and
 * asserted against a fake transport at the integration seam.
 */

import type {
  AgentRunRequest,
  BackendModel,
  KnowledgeSource,
  MemoryRecord,
  PermissionMode
} from "@fable/protocol";
import { buildContextPrefix, MAX_TOKENS_DEFAULT, validateModelForRun } from "@fable/connectors";

/**
 * The composer's permission-level picker uses user-facing labels; this maps each
 * to the protocol's PermissionMode vocabulary so the agent run can constrain
 * tool approvals. The protocol also uses these modes in approval requests.
 */
export interface PermissionProfile {
  label: string;
  description: string;
  mode: PermissionMode;
}

export const PERMISSION_PROFILES: readonly PermissionProfile[] = [
  {
    label: "Full with approvals",
    description: "Propose broad actions; approve consequential work",
    mode: "full-access"
  },
  {
    label: "Trusted",
    description: "Allow trusted work; approve sensitive or external actions",
    mode: "trusted-scope"
  },
  {
    label: "Read-only",
    description: "Read local and connected sources only",
    mode: "read-only"
  }
];

export const DEFAULT_PERMISSION_LABEL = PERMISSION_PROFILES[0].label;

/** The PermissionMode for a composer permission-level label (default = full-access). */
export function permissionModeFor(label: string): PermissionMode {
  return PERMISSION_PROFILES.find((profile) => profile.label === label)?.mode ?? "full-access";
}

/** The composer label for a PermissionMode (default = full with approvals). */
export function permissionLabelFor(mode: PermissionMode): string {
  return PERMISSION_PROFILES.find((profile) => profile.mode === mode)?.label ?? DEFAULT_PERMISSION_LABEL;
}

/** The plain description for a PermissionMode, surfaced wherever a profile is shown. */
export function permissionDescriptionFor(mode: PermissionMode): string {
  return (
    PERMISSION_PROFILES.find((profile) => profile.mode === mode)?.description ??
    PERMISSION_PROFILES[0].description
  );
}

export interface BuildContextPrefixForRunInput {
  memoryRecords: MemoryRecord[];
  knowledgeSources: KnowledgeSource[];
  /** Source ids the user has pinned into workspace context. */
  pinnedSourceIds: string[];
  /** When true, memory is skipped entirely (behavior unchanged). */
  memoryDisabled: boolean;
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
  const memory = input.memoryDisabled ? [] : input.memoryRecords.filter((record) => record.pinned);
  const pinnedIdSet = new Set(input.pinnedSourceIds);
  const sources = input.knowledgeSources.filter((source) => pinnedIdSet.has(source.id));
  return buildContextPrefix(memory, sources);
}

export interface BuildAgentRequestInput {
  model: string;
  prompt: string;
  maxTokens?: number;
}

/**
 * Shape the composer submission into a provider-neutral {@link AgentRunRequest}.
 * The providerId is NOT part of the request: the connected backend owns it (it
 * knows which provider it runs for), so the request carries only the model,
 * messages, tools, and token ceiling.
 */
export function buildAgentRequest(input: BuildAgentRequestInput): AgentRunRequest {
  return {
    model: input.model,
    messages: [{ role: "user", content: input.prompt }],
    tools: [],
    maxTokens: input.maxTokens ?? MAX_TOKENS_DEFAULT
  };
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
