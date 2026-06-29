# Fable-Owned Slash Commands — Design

**Date:** 2026-06-29
**Status:** Approved → implementing
**Scope:** Turn the `/goal`, `/plan`, `/remember`, and `/schedule` slash commands
from composer-text inserts into real, provider-neutral Fable features: typed
parsing, validation, execution, persistence, and user feedback. Define a
`CommandRuntime` execution layer that any backend family (native API, Codex,
ACP, Copilot) drives uniformly. Preserve normal prompt behavior and unknown-
command handling. Keep UI changes restrained and consistent with the existing
composer.

---

## 1. Current state (from read-only audit)

### What `/goal /plan /remember /schedule` do today
- `apps/desktop/src/components/Composer.tsx:19` lists `COMMANDS` and renders
  them in the "Commands" submenu of the Add menu. Selecting one calls
  `onRunCommand(command)`.
- `apps/desktop/src/hooks/useShellRuntime.ts:1520` `runCommand` does **one
  thing**: `setComposerValue("${command} ")` and focuses the textarea. There is
  **no parsing, no validation, no execution, no persistence**. The command is a
  dead stub that drops text into the composer.
- The only behavioral test (`App.test.tsx:584`) asserts the text round-trips:
  clicking `/goal` puts `"/goal "` in the composer. That is the entire surface.
- On submit, the composer text is sent to the agent loop verbatim (when a
  native backend is connected) or to knowledge-search. A literal `/goal` token
  reaches the model as ordinary prompt text.

### The stores these commands should write through
- **Memory (`/remember`):** `promoteToMemory` (`@fable/knowledge`) builds an
  `approved` `MemoryRecord`; the shell persists via `commitMemoryState` →
  `saveRuntimeMemoryState` → Rust `save_memory_state`. Provenance `origin:
  "manual"` is the contract-correct origin for hand-authored entries.
- **Schedule (`/schedule`):** `createSchedule` (`useShellRuntime.ts:1693`)
  builds a `ScheduledJob` (weekly RRULE-lite from day+time) + a one-step
  `WorkflowDefinition`, then calls `saveRuntimeScheduledJob` +
  `enqueueRuntimeJobRun` — the durable, crash-safe scheduler (`scheduler-store.json`).
- **Goal / Plan:** **No structured state exists today.** There is no `Goal` or
  `Plan` type anywhere in `@fable/protocol`. `/goal` and `/plan` have nothing
  to create.

### The hard persistence constraint (most important finding)
The runtime snapshot round-trips through Rust: `saveRuntimeSnapshot` →
`normalize_runtime_snapshot` (`apps/desktop/src-tauri/src/snapshot.rs:314`) →
`write_document`. The Rust `RuntimeSnapshot` struct (`models.rs:700`) has **no
`deny_unknown_fields`**, so any TS-only field (e.g. a new `goals: Goal[]`) is
**silently dropped** on the Rust round-trip — it survives only in the
best-effort localStorage mirror. To make Goal/Plan state **actually durable**,
the Rust struct + normalization must be extended, exactly as `schedules` was.

### Secrets boundary (must stay clean)
- No redaction runs on the memory write path today. `/remember "the prod DB
  password is hunter2"` would persist verbatim. A redaction step is mandatory.
- The connector/logging layer already has redaction vocabulary
  (`redact_connector_text`, `is_sensitive_payload_key`) but it is never invoked
  on memory payloads. The command layer adds its own pre-write redaction.

---

## 2. Typed command schemas (`@fable/protocol`)

New, additive, non-secret types. A command request is parsed from raw composer
text; a command result is the structured Fable state produced (or an error).

```ts
/** The Fable-owned commands. Provider-specific slashes never appear here. */
export type FableCommandName = "goal" | "plan" | "remember" | "schedule";

/** A parsed, validated command ready for execution. */
export interface FableCommandRequest {
  /** The canonical name without slash, e.g. "remember". */
  name: FableCommandName;
  /** The raw argument text after the command token, trimmed. */
  args: string;
}

/** Outcome of parsing raw composer text. */
export type ParseCommandOutcome =
  | { status: "command"; request: FableCommandRequest }
  | { status: "prompt"; text: string }   // ordinary prompt — not a command
  | { status: "unknown-command"; token: string; text: string }; // "/foo ..."

export type FableCommandStatus =
  | "ok"          // structured state created / persisted
  | "validation"  // args invalid (empty, malformed)
  | "rejected";   // secrets detected, or refused by policy

export interface FableCommandResult {
  name: FableCommandName;
  status: FableCommandStatus;
  /** Human-readable confirmation or error, surfaced via lastAction. */
  message: string;
  /** The created artifact (memory, schedule, goal, plan), if any. */
  artifactId?: string;
  /** When ok, the prompt — if any — to additionally submit to the model. */
  followUpPrompt?: string;
}
```

### New structured state: Goal and Plan

```ts
export interface WorkspaceGoal {
  id: string;
  title: string;
  /** The user's verbatim goal statement. */
  statement: string;
  status: "active" | "achieved" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface PlanStep {
  id: string;
  /** 1-based ordering. */
  order: number;
  description: string;
  done: boolean;
}

export interface WorkspacePlan {
  id: string;
  /** Optional link to the goal this plan decomposes. */
  goalId?: string;
  title: string;
  steps: PlanStep[];
  status: "draft" | "in-progress" | "complete";
  createdAt: string;
  updatedAt: string;
}
```

These are carried in the runtime snapshot (new `goals`/`plans` arrays) so they
persist across restarts — see §5 for the Rust extension.

---

## 3. Parser + validator (`@fable/connectors`)

A pure, transport-free module — same boundary as the native-API loop. No React,
no Tauri, no network. Fully unit-testable.

```
packages/connectors/src/commands/
  parse.ts          ← parseComposerText(text): ParseCommandOutcome
  parse.test.ts
  redact.ts         ← redactSecrets(value): { safe; refused }  (for /remember)
  redact.test.ts
  dispatch.ts       ← executeCommand(req, deps): Promise<FableCommandResult>
  dispatch.test.ts
  index.ts          ← barrel (re-exported from the package barrel)
```

### `parseComposerText`
- Input: the full composer text.
- A command is recognized **only** when the first non-whitespace token starts
  with `/` and is immediately followed by a known name, then whitespace or EOL.
  This mirrors how users type (`/remember ...`), not deep in prose.
- `/goal`, `/plan`, `/remember`, `/schedule` → `{ status: "command", request }`.
- `/anything-else` → `{ status: "unknown-command", token, text }` — preserved
  verbatim so the **provider passthrough** path (§6) can decide.
- Otherwise → `{ status: "prompt", text }`. Ordinary prompt behavior is
  unchanged.

### `redactSecrets` (for `/remember`)
- Reuses the codebase's secret markers. Returns `{ safe, refused: boolean }`.
- Refuses values containing bearer/authorization/token/password/secret markers
  and high-signal secret shapes (`sk-`, `ghp_`, `xox[bp]-`, `AKIA…`, long
  base64-ish JWTs). A refused value yields `status: "rejected"` with a message
  naming what was caught, **without echoing the secret back**.

### `executeCommand` (the provider-neutral execution layer)
- Signature:
  ```ts
  executeCommand(
    request: FableCommandRequest,
    deps: CommandRuntime
  ): Promise<FableCommandResult>
  ```
- `CommandRuntime` is the provider-neutral seam every backend family honors:
  ```ts
  export interface CommandRuntime {
    /** Create a memory via the knowledge/memory boundary. */
    createMemory(input: { title: string; value: string; kind: MemoryKind }): Promise<MemoryRecord>;
    /** Create a durable schedule. */
    createSchedule(input: ScheduleCommandInput): Promise<ScheduledJob>;
    /** Create a structured goal. */
    createGoal(input: { title: string; statement: string }): Promise<WorkspaceGoal>;
    /** Create a structured plan (optionally linked to a goal). */
    createPlan(input: { title: string; steps: string[]; goalId?: string }): Promise<WorkspacePlan>;
    /** Now, injectable for deterministic tests. */
    now(): string;
  }
  ```
- Behavior per command:
  - **`/remember <value>`** → redact → `createMemory` (kind derived: defaults
    to `"fact"`). Result message confirms the memory title. `followUpPrompt`
    is empty (no model work — pure persistence).
  - **`/goal <statement>`** → `createGoal`. Sets the active goal in shell state.
    `followUpPrompt` asks the model to decompose the goal into a plan **only
    when a connected streaming backend exists**; otherwise the goal is still
    created and the user is told to connect a backend to plan it.
  - **`/plan <description>`** → `createPlan` with the description as a single
    draft step, or, when a goal is active, a prompt to decompose it. Model work
    is submitted through the resolved `AgentBackend`/agent run when available.
  - **`/schedule <natural language>`** → parse a minimal, deterministic subset
    (`every day at 09:00`, `weekly on Mon at 09:00`, `at 2026-07-01 09:00`,
    `daily|weekly|monthly`) into a `ScheduleTrigger`, validate via
    `validateScheduleTrigger`, then `createSchedule`. Unknown phrasing →
    `status: "validation"` with guidance, never a silent misfire.

---

## 4. Provider-neutral execution across backends

- The shell resolves **one** command runtime per run, the same way it resolves
  one agent backend. Today only native-API is connected+streaming, so
  `createSchedule`/`createMemory` route through the existing wired paths; for
  future backends the same `CommandRuntime` interface is implemented by that
  backend's adapter. The command layer never branches on provider id.
- `/goal` and `/plan` submit model work by handing a `followUpPrompt` back to
  the caller (App.tsx), which submits it through the **existing** agent run
  (`agent.run(buildAgentRequest(...))`) — i.e. through `runAgentLoop` and
  whatever `AgentBackend` is resolved. No new egress path, no secret crossing.
- Commands work identically whether nothing is connected (state created, model
  work skipped with a clear message) or a backend is connected (state created
  **and** model work submitted). This is the cross-backend contract.

---

## 5. Persistence

- **Memory:** unchanged boundary — `promoteToMemory` + `commitMemoryState`.
  `/remember` is the first free-text entry into memory (today memory enters only
  via source promotion or edit). Redaction runs before `promoteToMemory`.
- **Schedule:** unchanged boundary — reuses the exact `createSchedule` +
  `saveRuntimeScheduledJob`/`enqueueRuntimeJobRun` path the form uses.
- **Goal / Plan:** new durable state. Added to:
  - `@fable/protocol` `RuntimeSnapshot` (`goals: WorkspaceGoal[]`,
    `plans: WorkspacePlan[]`).
  - `apps/desktop/src/lib/types.ts` `PersistedShellState`.
  - **Rust** `RuntimeSnapshot` struct + `normalize_runtime_snapshot` (with
    `#[serde(default)]` and the same caps/normalization pattern as schedules),
    so the state survives the Tauri round-trip — not just localStorage.
- No secret lands in any command payload, log, snapshot, or JSON state. The
  `/remember` redaction gate is the enforcement point; existing
  `persistence.test.ts` assertions are kept green.

---

## 6. Provider-specific slash passthrough

- `parseComposerText` returns `unknown-command` for any `/foo` not owned by
  Fable. The shell treats `unknown-command` as ordinary prompt text by default
  (behavior preserved).
- A provider may **opt in** to passthrough later via an explicit allowlist on
  the connected backend's capabilities. This goal does **not** add passthrough;
  it reserves the seam by separating `unknown-command` from `prompt` so a future
  capability can route `/codex:foo` to a backend without colliding with Fable's
  commands. Fable's commands are never replaced.

---

## 7. Shell + UI wiring

- `runCommand(command)` (the Add-menu click) keeps inserting `"${command} "`
  into the composer — that UX is retained and tested. The change is in the
  **submit** path.
- The composer submit handler (`App.tsx` `onSubmit`) runs
  `parseComposerText(composerValue)` **first**:
  - `command` → `executeCommand(req, runtime)`; surface `result.message` via
    `setLastAction`; if `result.followUpPrompt` and a backend is connected,
    submit it through the agent run; clear/keep the composer per result.
  - `unknown-command` → fall through to ordinary prompt submission (preserved).
  - `prompt` → unchanged submit path.
- UI changes are restrained: no new components, no new menus. Feedback is the
  existing `lastAction` channel plus the already-rendered Goals/Schedules/
  Memory surfaces. (A small Goals surface may reuse existing list styling if
  needed; kept minimal.)

---

## 8. Testing

Pure unit tests in `packages/connectors/src/commands/`:
- `parse.test.ts` — command vs prompt vs unknown-command; whitespace/leading;
  args trimming; each of the four commands; `/foo` passthrough reservation.
- `redact.test.ts` — refuses bearer/token/password/secret markers and secret
  shapes; passes clean values; never echoes the secret in the message.
- `dispatch.test.ts` — each command's happy path + validation + rejection;
  `/goal` followUpPrompt present only when a backend is connected; `/schedule`
  trigger parsing for daily/weekly/monthly/once + invalid → validation.

Persistence/integration tests:
- Extend the snapshot round-trip test to assert `goals`/`plans` survive the
  Rust normalization (mirrors the existing schedules persistence test).
- `App.test.tsx` — `/remember` creates a memory visible on the Knowledge page;
  `/schedule` creates a schedule; `/goal` sets a goal; unknown `/foo` still
  submits as a prompt; the Add-menu click still inserts text.

Existing tests (`App.test.tsx`, `useNativeAgent.test.tsx`, scheduler tests,
`persistence.test.ts`) stay green.

---

## 9. Verification gates

- `pnpm check` (typecheck + test + build + tauri:check)
- `pnpm lint`
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`

---

## 10. What this does NOT do

- Does not add UI for editing goals/plans beyond what is needed to surface them.
- Does not implement provider passthrough (reserves the seam only).
- Does not change the secrets boundary; it adds the missing redaction on the
  `/remember` path.
- Does not change how schedules execute (reuses the durable scheduler).
