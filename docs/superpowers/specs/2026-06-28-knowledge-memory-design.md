# Knowledge & Adaptive Memory — Design

Status: **Implemented**. Fully implemented in Batch 10 (branches `codex/batch-10-knowledge-foundation`, `codex/batch-10-local-retrieval`, `codex/batch-10-lifecycle-quality`). Refer to the runtime reference: [Knowledge & Memory Lifecycle Reference](../../../product/knowledge-lifecycle.md).

## 1. Objective recap

Build Fable's complete minimalist Knowledge and adaptive memory layer on top of
the current local-first foundations. It must feel like **infrastructure, not a
dashboard**: no excessive panels, cards, metrics, taxonomies, helper copy, or
configuration.

The objective names six first-class concepts. They resolve to concrete types:

| Objective term | Type in this system | One-liner |
| --- | --- | --- |
| Source | `KnowledgeSource` (+ new `SourceRecord` chunk index) | Imported or connected material with provenance |
| Memory | `MemoryRecord` (extended) | Concise durable info explicitly retained about the user/work |
| Pinned context | `pinnedSourceIds` / `MemoryRecord.pinned` | User-selected material always available in a scope |
| Working context | `WorkingContext` | Temporary context tied to a thread/project/run |
| Artifact | `Artifact` | Useful output produced by completed work |
| History | (existing `PersistedAgentRun`) | Prior conversations/runs — **not** durable memory |

Existing `LocalFileImport`, `KnowledgeSource`, `KnowledgeCitation`,
`MemoryRecord`, `searchKnowledgeSources`, `buildContextPrefix`, and the shell
runtime's `importedKnowledgeSources` / `pinnedSourceIds` / `memoryRecords` state
are the foundation. This design **extends** them, never forks them.

## 2. Architecture — one new package, three layers

```
packages/protocol   ── domain types (Source/Memory/Artifact/scope/provenance)
packages/knowledge  ── NEW. Ingestion, retrieval, memory, context-assembler,
                        storage repository interfaces + default store.
packages/connectors ── unchanged except a new ConnectorSourceProvider contract
                        module (interface only — no connector impl imports).
apps/desktop        ── KnowledgePage rebuilt; useShellRuntime wired to the
                        knowledge layer; context prefix sourced from assembler.
```

**Layering rule:** `@fable/protocol` is types only. `@fable/knowledge` depends
on `@fable/protocol` only. `@fable/connectors` keeps owning local-file import +
lexical search but imports the `ConnectorSourceProvider` contract from protocol
(or knowledge) — it does **not** import any connector implementation. Desktop
depends on all three.

**Persistence rule:** storage is defined **behind interfaces** in the knowledge
package. Browser preview uses JSON/localStorage-compatible state, while the
production Tauri path uses encrypted SQLite repositories through the same
runtime boundary. No competing database architecture is introduced.

## 3. Domain types (protocol additions)

All new types go in `packages/protocol/src/index.ts`. Existing types are
**extended, not replaced**. Additive fields are optional so old snapshots still
load.

### 3.1 Scope

```ts
export type KnowledgeScopeLevel = "global" | "project" | "thread";
export interface KnowledgeScope {
  level: KnowledgeScopeLevel;
  projectId?: string;
  threadId?: string;
}
export const GLOBAL_SCOPE: KnowledgeScope = { level: "global" };
```

Scope is how retrieval, memory, and pinned context are bounded. The existing
global-only state maps to `level: "global"`.

### 3.2 Source — extended

Extend `KnowledgeSource` additively with chunk-index metadata, and add the
chunk + ingestion-result records:

```ts
// Additive optional fields on KnowledgeSource:
//   scope?: KnowledgeScope        (defaults to GLOBAL_SCOPE)
//   account?: string              (connector account provenance)
//   embeddingReady?: boolean      (true once chunks have embeddings)
//   authority?: number            (0..1 connector/local trust weight)
//   disabled?: boolean            (soft-delete / exclusion)
//   status?: SourceStatus         ("ok" | "indexing" | "stale" | "error")

export type SourceStatus = "ok" | "indexing" | "stale" | "error";

export interface SourceChunk {
  id: string;              // stable: `${sourceId}#${ordinal}`
  sourceId: string;
  ordinal: number;
  text: string;
  // content hash of THIS chunk (structure-aware chunking)
  contentHash: string;
  heading?: string;        // nearest heading, when chunked by structure
  charStart: number;
  charEnd: number;
  embedding?: number[];    // present when an embedding provider ran
  embeddingModel?: string;
}

export interface SourceRecord {
  source: KnowledgeSource;
  chunks: SourceChunk[];
}

export type IngestionOutcome =
  | { kind: "created"; source: KnowledgeSource; chunks: SourceChunk[] }
  | { kind: "updated"; source: KnowledgeSource; chunks: SourceChunk[]; previousFingerprint: string }
  | { kind: "unchanged"; source: KnowledgeSource }
  | { kind: "skipped"; reason: SkipReason; detail: string };

export type SkipReason =
  | "unsupported-type"
  | "oversized"
  | "empty"
  | "malformed"
  | "binary"
  | "inaccessible"
  | "too-many-files";
```

### 3.3 Memory — extended

Extend `MemoryRecord` additively with provenance, scope, confidence,
freshness, approval, and a forget/tombstone mechanism. The existing `pinned`,
`approved`, `freshness`, `source` fields stay. New optional fields:

```ts
// Additive optional fields on MemoryRecord:
//   id stays the primary key (already exists)
//   scope?: KnowledgeScope        (defaults to GLOBAL_SCOPE)
//   confidence?: number           (0..1; 1 = user-confirmed)
//   provenance?: MemoryProvenance
//   approvalState?: "approved" | "suggested" | "rejected"
//   runId?: string                (originating run, when promoted from a run)
//   createdAt?: string            (ISO)
//   updatedAt?: string            (ISO)
//   forgottenAt?: string          (ISO; present => tombstone, excluded everywhere)

export interface MemoryProvenance {
  origin: "chat" | "source" | "artifact" | "run" | "manual";
  sourceId?: string;
  runId?: string;
  artifactId?: string;
  note: string;
}

export interface MemorySuggestion {
  id: string;
  title: string;
  value: string;
  kind: MemoryKind;
  provenance: MemoryProvenance;
  confidence: number;
  /** A detected duplicate-of / contradiction-with an existing memory id, if any. */
  duplicateOfId?: string;
  contradictsId?: string;
}

export interface MemoryRetentionResult {
  prunedIds: string[];
  reasons: Record<string, "stale" | "superseded" | "low-confidence">;
}
```

**Forget semantics:** setting `forgottenAt` is the durable exclusion signal.
The store and retrieval layer filter `forgottenAt` records out of every read
path; tests prove deleted/forgotten/disabled memory and sources cannot enter a
run. This is preferred over hard delete so it survives store round-trips and
stays auditable.

### 3.4 Pinned & working context & artifacts

```ts
export interface PinnedContextEntry {
  id: string;
  scope: KnowledgeScope;
  // exactly one of:
  sourceId?: string;
  memoryId?: string;
  pinnedAt: string;
}

export interface WorkingContext {
  runId: string;
  scope: KnowledgeScope;
  messageIds: string[];           // current conversation message refs
  retrievedCitationIds: string[]; // citations pulled for this run
  memoryIds: string[];            // approved memories applied
  toolResultIds: string[];
  createdAt: string;
}

export interface Artifact {
  id: string;
  title: string;
  kind: "document" | "code" | "summary" | "other";
  content: string;
  provenance: { runId: string; createdAt: string; sourceIds: string[] };
  scope?: KnowledgeScope;
  pinned?: boolean;
}
```

## 4. Storage seam

A repository interface in the knowledge package. The default impl is the
existing JSON/localStorage pattern wrapped in a thin adapter for preview; the
production Tauri path persists through encrypted SQLite repositories behind the
native command boundary.

```ts
export interface KnowledgeStore {
  sources(): KnowledgeSource[];
  source(id: string): KnowledgeSource | undefined;
  chunks(sourceId: string): SourceChunk[];
  upsertSource(record: SourceRecord): void;
  removeSource(id: string): void;

  memories(): MemoryRecord[];                 // excludes forgotten
  memory(id: string): MemoryRecord | undefined;
  upsertMemory(record: MemoryRecord): void;
  removeMemory(id: string): void;

  pinned(scope: KnowledgeScope): PinnedContextEntry[];
  pin(entry: PinnedContextEntry): void;
  unpin(id: string): void;

  artifacts(): Artifact[];
  upsertArtifact(artifact: Artifact): void;

  export(): { sources: KnowledgeSource[]; memories: MemoryRecord[] };
}
```

The preview store remains `createJsonKnowledgeStore` (in-memory map,
snapshot-ready) and round-trips through localStorage. Production desktop state
uses the encrypted SQLite repository layer and typed runtime commands. **No new
database.**

## 5. Connector-source contract

```ts
// packages/protocol (or knowledge) — interface only
export interface ConnectorSourceProvider {
  readonly connectorId: ConnectorId;
  listSources(): AsyncIterable<ConnectorSourceCandidate> | ConnectorSourceCandidate[];
}

export interface ConnectorSourceCandidate {
  externalId: string;        // provider-stable id
  title: string;
  mimeType: string;
  content: string;           // extracted text; empty if binary/extraction-failed
  sizeBytes: number;
  fetchedAt: string;
  account?: string;
  providerMetadata?: Record<string, string>;
}
```

The knowledge ingestion pipeline accepts `ConnectorSourceCandidate`s uniformly.
Each connector branch implements `ConnectorSourceProvider` independently; this
package never imports connector implementations. This satisfies "stable
ingestion contract compatible with all connector branches."

## 6. Ingestion pipeline

`@fable/knowledge` `src/ingestion/`. Pure functions, no React/transport.

- **IDs:** stable `source-${connectorId}-${slug(contentHash)}`; chunk id
  `${sourceId}#${ordinal}`. Re-importing identical content yields the same id
  (dedup).
- **Hash:** SHA-256 of normalized text (replaces the local FNV hash for content
  integrity; the existing `localFileFingerprint` stays for the legacy preview
  preview path and is mapped to `contentFingerprint`).
- **Extraction:** reuses the supported text formats already in the toolchain
  (`txt/md/markdown/json/csv/yaml/yml`). Unsupported/malformed/binary/oversized
  → bounded `IngestionOutcome` with a `SkipReason`; never throws out of the
  pipeline.
- **Chunking:** structure-aware where possible — split Markdown on headings,
  JSON on top-level object boundaries, CSV on row-group boundaries; otherwise
  fixed window with sentence/paragraph boundaries and overlap. Each chunk gets
  a content hash.
- **Incremental reindex:** compare content hash to existing; emit
  `unchanged`/`updated`. Folder indexing: detect moves/renames by content-hash
  match (same hash, different path → treat as move, preserve id). Deletions
  surface for the store to `removeSource`. Dedup across the store by hash.
- **Folder indexing:** recursive with a file-count cap and per-file size cap;
  over-cap → `skipped/too-many-files` for the overflow, bounded.

## 7. Retrieval pipeline

`@fable/knowledge` `src/retrieval/`. Pure, pluggable.

- **Lexical core:** generalizes the existing `searchKnowledgeSources` to chunks
  (BM25-lite scoring over chunk text + title/heading boosts).
- **Semantic core (pluggable):** `EmbeddingProvider` interface; a chunk's
  `embedding` is used when present. A `no-embedding` provider returns no
  vectors → retrieval transparently falls back to lexical-only (the existing
  `lexical-fallback` mode), satisfying "usable no-embedding fallback."
- **Hybrid:** when embeddings exist, fuse lexical + cosine with reciprocal-rank
  fusion; otherwise lexical only. Mode is reported on the response (already a
  protocol field: `KnowledgeSearchResponse.mode`).
- **Scope filter:** project / thread / source / connector / account / user
  selection.
- **Ranking:** relevance + recency + source authority + pinning + explicit
  user feedback (a `feedback` weight map). The basis is never hidden — every
  citation carries the components that pushed it up.
- **Budgets + dedup:** a character/token budget; overlapping chunks from the
  same source are merged/deduplicated before budgeting.
- **Stale exclusion:** `disabled`, `forgottenAt`, stale-by-policy, or
  inaccessible sources are filtered before scoring. Tests prove deleted/
  disabled/stale material cannot enter context.

```ts
export interface EmbeddingProvider {
  readonly id: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}
export interface LexicalProvider {
  score(queryTokens: string[], chunk: SourceChunk): number;
}
export interface RetrievalRanking {
  relevance: number; recency: number; authority: number; pin: number; feedback: number;
}
```

## 8. Memory pipeline

`@fable/knowledge` `src/memory/`. Pure.

- **Promotion (explicit):** `promoteToMemory(input)` builds a `MemoryRecord`
  with provenance + scope + approvalState `"approved"` only when the user
  confirms. From a chat/source/artifact/run origin.
- **Suggestions (not silent):** `suggestMemories(context)` returns
  `MemorySuggestion[]` with `duplicateOfId`/`contradictsId` — it **never**
  writes. Suggestion→memory only happens via explicit approve.
- **CRUD:** view/edit/pin/unpin/disable/forget/export/delete — all operate via
  the store; `forget` sets `forgottenAt`.
- **Dedup + contradiction:** `detectDuplicates`/`detectContradictions` compare
  candidate vs existing memory (normalized text similarity for dup; negation /
  opposing-fact heuristics for contradiction). Surfaced on suggestions and on
  manual create.
- **Retention/staleness:** `applyRetention(policy, now)` prunes memories past a
  TTL unless pinned/approved; returns reasons.
- **Scope boundaries:** global/project/thread; retrieval + context assembler
  respect `memory.scope`.

## 9. Agent integration — bounded context assembler

`@fable/knowledge` `src/context/`. Pure. **Replaces** the use of
`buildContextPrefixForRun` directly in `agent-run.ts` wiring — the assembler
subsumes it (the old function stays for back-compat/tests).

Deterministic assembly order (each item recorded with *why* it entered):

1. System instructions (static prefix)
2. Current conversation (latest N turns, budget-boxed)
3. Selected project context (project-scoped pinned sources/memory)
4. Pinned context (scope-respecting)
5. Approved memory (scope-respecting, `forgottenAt` excluded)
6. Retrieved source excerpts (from retrieval, with citations)
7. Tool results (most recent)

Output: `AssembledContext { systemPrefix; messages; citations; usage }` where
`usage` lists each contributed memory/source id and reason, and `citations`
ties each excerpt to an exact `KnowledgeSource`/`SourceChunk`. Internal
chain-of-thought is never exposed — only these inspectable citations + memory
usage. Disabled/unauthorized content is excluded by construction (store filters
+ an authorization predicate the caller supplies).

Artifacts: on a completed run, `saveArtifactFromRun(run, content)` writes an
`Artifact` with provenance + link back to `runId`.

## 10. Knowledge page — minimal UI

Rebuild `KnowledgePage.tsx` only. **Do not redesign other screens.**

- Primary surface: a single **searchable list** with a restrained Sources /
  Memory mode switch (two tabs, not a dashboard).
- Actions available inline + a single import/connect affordance: import,
  connect, inspect, edit, forget, refresh, delete.
- Progressive disclosure: inspect/edit open a focused detail panel, not nested
  cards. No metrics, taxonomies, or explanatory copy beyond labels.
- Reuse existing visual language (the `PageHeader`, list patterns, tokens
  already used by Connectors/Schedules pages).
- Verify desktop + narrow layouts via screenshots. Empty / loading / indexing /
  failed / populated / deleted states each have a test.

## 11. Wiring

- `useShellRuntime`: the existing `importedKnowledgeSources`, `pinnedSourceIds`,
  `memoryRecords` state is backed by a `KnowledgeStore` instance (default JSON
  store). New actions: refresh source, delete source, forget memory, promote
  suggestion. Existing actions (import local file, pin/unpin, promote to
  memory) route through the knowledge pipeline.
- `agent-run.ts` / `useNativeAgent`: the run's `contextPrefix` is produced by
  the context assembler (scoped, cited) instead of the bare prefix.
- Persistence: the runtime snapshot gains `knowledgeStore` snapshot fields
  (additive; old snapshots load with defaults). Tauri snapshot ↔ store on
  save/recover. **Goal 8 migration documented** in §13.

## 12. Tests (must cover)

- Ingestion: hashing, structure-aware chunking, dedup, incremental reindex,
  move/rename handling, deletion, folder cap, bounded failure (unsupported/
  malformed/binary/oversized/inaccessible).
- Retrieval: ranking order (relevance/recency/authority/pin/feedback), context
  budget enforcement, overlapping-chunk dedup, citation integrity (each
  citation resolves to a real source+chunk), scope isolation, no-embedding
  fallback, **stale/deleted/disabled exclusion from context**.
- Memory: promotion produces approved+provenance; duplicate + contradiction
  detection; retention prunes; **forgotten memory excluded from future
  contexts**; scope boundaries.
- Context assembler: deterministic order, disabled/unauthorized excluded,
  `usage` records why each item entered, citations resolve, artifact saved
  with provenance.
- Provider failures: embedding provider throws → falls back to lexical; no
  uncaught throw.
- UI states: empty, loading, indexing, failed, populated, deleted — via the
  existing `useShellRuntime.test.tsx` test harness.

## 13. Schema + migration

The integrated Batch 10 schema is documented in
`docs/product/knowledge-lifecycle.md`,
`docs/architecture/encrypted-storage.md`, and
`docs/architecture/workspace-data-model.md`. Those documents capture:

- The logical schema (sources, chunks, memories, pinned, artifacts, working
  context) and their additive optional fields.
- The migration from the current `RuntimeSnapshot` (v1) fields
  (`importedKnowledgeSources`, `pinnedSourceIds`, `memoryRecords`,
  `memoryDisabled`) into the store-backed snapshot fields. All new fields are
  additive/optional, so a v1 snapshot loads unchanged.
- The storage-interface swap point: encrypted SQLite implements the production
  `KnowledgeStore` boundary, while browser preview remains local fixture state.
- The connector-source contract for future connector branches implementing
  `ConnectorSourceProvider`.

## 14. Definition of done (mapped)

- ✅ Local sources import/index/refresh/search/cite/delete → §6, §7, store.
- ✅ Connector-derived content stable contract → §5.
- ✅ Memory explicit, provenance-bearing, editable, reversible → §8.
- ✅ Agent runs receive bounded relevant context → §9.
- ✅ Knowledge page minimal + functional → §10.
- ✅ Tests + visual checks pass → §12.
- ✅ Committed on `codex/knowledge-memory`, not merged → §2.

## 15. Non-goals (explicit)

No connector auth, no app redesign, no schedules/voice/installers/signing/
updater/distribution/launch, no push/merge, no competing database, no
modification of connector-specific implementations.
