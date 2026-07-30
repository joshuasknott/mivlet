import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { PuzzlePiece } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { SUPPORTED_LOCAL_FILE_EXTENSIONS } from "@fable/connectors/local-files";

/**
 * Workspace shell constants. Extracted from App.tsx so the persistence,
 * snapshot, and runtime layers can share a single source of truth.
 */

export const STORAGE_KEY = "fable.shell.v1";
/**
 * Read-only compatibility keys. Do not rename or remove: existing installs
 * used these exact localStorage namespaces before the Fable rebrand.
 */
export const LEGACY_STORAGE_KEYS = ["arden.shell.v1", "praxis.shell.v1"] as const;
/**
 * One-time legacy-import marker for desktop. Set to `"1"` after the first
 * launch so the desktop runtime never re-reads legacy localStorage keys — the
 * runtime snapshot is the source of truth from then on. Preview (no Tauri
 * runtime) never touches this.
 */
export const LEGACY_IMPORT_SENTINEL = "fable.legacy-imported.v1";
export const RUNTIME_SNAPSHOT_VERSION = 1 as const;
export const MAX_APPROVAL_AUDIT_ENTRIES = 200;
export const MAX_IMPORTED_KNOWLEDGE_SOURCES = 100;

export const ACCEPTED_LOCAL_KNOWLEDGE_FILES = SUPPORTED_LOCAL_FILE_EXTENSIONS.map(
  (extension) => `.${extension}`
).join(",");

export const ACCEPTED_COMPOSER_ATTACHMENTS = [
  ACCEPTED_LOCAL_KNOWLEDGE_FILES,
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
].join(",");

export const utilityItems = [
  { label: "Connectors", icon: PuzzlePiece },
  { label: "Knowledge", icon: Stack },
  { label: "Schedules", icon: Lightning }
] as const;
