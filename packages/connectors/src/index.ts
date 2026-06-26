/**
 * Public barrel for the @arden/connectors package.
 *
 * Re-exports two concerns kept in separate modules:
 *   - logic: local-file import + lexical knowledge search (local-files.ts,
 *     knowledge-search.ts)
 *   - data: fixture-only connector/directive/thread/project/knowledge/automation
 *     catalogs (fixtures.ts)
 *
 * The desktop shell imports these via @arden/connectors; this surface is the
 * package's public protocol and must stay stable.
 */

// logic
export {
  importLocalTextFile,
  localFileFingerprint,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_FILE_PREVIEW_CHARACTERS,
  SUPPORTED_LOCAL_FILE_EXTENSIONS
} from "./local-files";
export type { LocalTextFileCandidate } from "./local-files";
export { searchKnowledgeSources } from "./knowledge-search";

// data (preview/demo fixtures)
export {
  automationFixtures,
  chatThreadFixtures,
  connectorFixtures,
  directiveFixtures,
  knowledgeSourceFixtures,
  projectFixtures
} from "./fixtures";
