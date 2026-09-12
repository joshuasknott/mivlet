/** Secret-free local defaults used before native state finishes loading. */

import { listSupportedConnectors } from "@fable/connectors";
import type {
  KnowledgeSource,
  MemoryRecord,
  ThreadSummary
} from "@fable/protocol";

export const connectors = listSupportedConnectors();
export const chatThreads: ThreadSummary[] = [];
export const knowledgeSources: KnowledgeSource[] = [];
export const memoryRecords: MemoryRecord[] = [];
