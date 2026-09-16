/** Secret-free local defaults used before native state finishes loading. */

import { listSupportedConnectors } from "@mivlet/connectors";
import type { KnowledgeSource, MemoryRecord } from "@mivlet/protocol";

export const connectors = listSupportedConnectors();
export const knowledgeSources: KnowledgeSource[] = [];
export const memoryRecords: MemoryRecord[] = [];
