/**
 * Desktop shell preview/demo data.
 *
 * This module is the single ownership boundary for the demo data the Fable
 * desktop shell renders before any live connectors are wired up. It does two
 * things:
 *
 * 1. Re-exports the shared fixture catalogs owned by `@fable/connectors`
 *    (connector manifests, directives, threads, and knowledge sources) under
 *    the plain names the shell components use.
 * 2. Owns the desktop-local fixtures that have no place in the connectors
 *    package: durable `memoryRecords` and `pendingApprovals`.
 *
 * Everything here is preview/demo data. It must not contain real credentials,
 * live API responses, or user-specific secrets. When real connectors and a
 * durable store land, these exports are replaced with hydrated runtime state.
 */

import {
  chatThreadFixtures,
  connectorFixtures,
  directiveFixtures,
  knowledgeSourceFixtures
} from "@fable/connectors";
import type { ApprovalRequest, MemoryRecord } from "@fable/protocol";

// Shared fixture catalogs — owned by @fable/connectors, re-exported here so
// shell components import demo data from one place.
export const workspaceDirectives = directiveFixtures;
export const connectors = connectorFixtures;
export const chatThreads = chatThreadFixtures;
export const knowledgeSources = knowledgeSourceFixtures;

// Desktop-local preview fixtures — owned here (no connector equivalent).
// Memory and approvals start empty; they populate as the user promotes sources
// into memory and connector actions surface approval requests.
export const memoryRecords: MemoryRecord[] = [];

export const pendingApprovals: ApprovalRequest[] = [];
