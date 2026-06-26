import { PuzzlePiece, Lightning, Stack } from "@phosphor-icons/react";
import { SUPPORTED_LOCAL_FILE_EXTENSIONS } from "@arden/connectors";

/**
 * Workspace shell constants. Extracted from App.tsx so the persistence,
 * snapshot, and runtime layers can share a single source of truth.
 */

export const STORAGE_KEY = "arden.shell.v1";
export const LEGACY_STORAGE_KEY = "praxis.shell.v1";
export const RUNTIME_SNAPSHOT_VERSION = 1 as const;
export const MAX_APPROVAL_AUDIT_ENTRIES = 200;
export const MAX_IMPORTED_KNOWLEDGE_SOURCES = 100;

export const ACCEPTED_LOCAL_KNOWLEDGE_FILES = SUPPORTED_LOCAL_FILE_EXTENSIONS.map(
  (extension) => `.${extension}`
).join(",");

export const utilityItems = [
  { label: "Knowledge", icon: Stack },
  { label: "Plugins", icon: PuzzlePiece },
  { label: "Automations", icon: Lightning }
] as const;
