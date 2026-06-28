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
