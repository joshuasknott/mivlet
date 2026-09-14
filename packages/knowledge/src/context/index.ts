/**
 * Barrel for the bounded context assembler and history planner.
 *
 * Assembles the agent run's system context in a deterministic order, records
 * why each memory/source entered the run, excludes disabled/unauthorized/
 * forgotten content, and surfaces inspectable citations + memory usage without
 * exposing internal chain-of-thought. Re-exported additively from the package
 * barrel.
 */

export {
  assembleContext,
  type AssembleContextInput,
  type AssembledContext,
  type AssembledCitation,
  type ContextAuthorizationRules,
  type ContextContribution,
  type ContextContributionReason
} from "./assemble";

export {
  planBoundedHistory,
  retrieveElidedHistory,
  safeHistoryStart,
  selectRecentHistory,
  DERIVED_HISTORY_POLICY,
  RETRIEVED_HISTORY_POLICY,
  type BoundedHistoryBudget,
  type BoundedHistoryDiagnostics,
  type BoundedHistoryInput,
  type BoundedHistoryPlan,
  type HistoryEntry,
  type RetrievedHistoryExcerpt
} from "./history";

export {
  foldHistorySummary,
  invalidateSummariesForMemory,
  isUsableSummary,
  summariesForThread,
  MAX_SUMMARY_CHARACTERS,
  type FoldHistorySummaryInput,
  type InvalidationResult
} from "./compaction";
