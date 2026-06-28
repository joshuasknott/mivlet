/**
 * Barrel for the bounded context assembler.
 *
 * Assembles the agent run's system context in a deterministic order, records
 * why each memory/source entered the run, excludes disabled/unauthorized/
 * forgotten content, and surfaces inspectable citations + memory usage without
 * exposing internal chain-of-thought. Re-exported additively from the package
 * barrel.
 */

export {
  artifactFromRun,
  assembleContext,
  type AssembleContextInput,
  type AssembledContext,
  type AssembledCitation,
  type ContextAuthorizationRules,
  type ContextContribution,
  type ContextContributionReason
} from "./assemble";
