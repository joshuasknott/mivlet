/**
 * Barrel for the memory pipeline.
 *
 * Pure functions only: promotion, duplicate/contradiction detection, suggestion
 * (no writes), retention, and CRUD actions. The storage seam itself lives in
 * `../store`. Re-exported additively from the package barrel.
 */

export {
  approveSuggestion,
  promoteToMemory,
  type PromoteMemoryInput
} from "./promote";

export {
  promoteCompletedWorkOutcome,
  promoteSideChatOutcome,
  resolvePromotionScope,
  MAX_PROMOTED_RECORDS,
  MAX_PROMOTED_TITLE_CHARACTERS,
  MAX_PROMOTED_VALUE_CHARACTERS,
  type CompletedWorkPromotionInput,
  type OutcomeSourceMessage,
  type PromotionOwners,
  type SideChatPromotionInput
} from "./promotion";

export { detectContradiction, detectDuplicate } from "./duplicate";

export { suggestMemories, type MemorySuggestionContext } from "./suggest";

export {
  applyRetention,
  DEFAULT_RETENTION_POLICY,
  type MemoryRetentionPolicy
} from "./retention";

export {
  disableMemory,
  editMemory,
  exportMemories,
  forgetMemory,
  pinMemory,
  unpinMemory
} from "./actions";
