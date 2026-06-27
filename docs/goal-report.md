> ⚠️ **SUPERSEDED (2026-06-27).** This report captures the state of the project
> at the completion of the Fable rebrand + architecture/UI-overhaul goal on
> 2026-06-26. It **predates** the subsequent native-API transport, the native
> agent loop, and the connectors (provider/first-wave) work, none of which are
> reflected here. Treat all claims below — including the Tauri identifier
> (`com.fable.workspace`), the "working tree clean" note, and the test counts
> (24 Rust / 26 TS) — as **historical** snapshots, not the current state. This
> file is retained for provenance only; it is not an authoritative status doc.

# Goal Report — Fable Rebrand, Architecture Cleanup & UI Overhaul

Completed: 2026-06-26. All four phases done in order, each gated on green checks.
No deferred roadmap work was started. No real credentials/OAuth were introduced.
The pre-existing WIP was preserved, understood, and built upon.

---

## 1. Definition of Done — status

| Requirement | Status |
|---|---|
| App.tsx is root/composition only | ✅ 2032 → **192 lines** |
| lib.rs is registration/startup only | ✅ 2204 → **39 lines** |
| Styles split into focused files | ✅ 1 monolith → **8 layer files** |
| Fixtures have clear ownership | ✅ desktop-local vs shared separated |
| Rebrand complete & consistent | ✅ see §3 |
| UI meets every Phase 3 checkbox | ✅ see §4 |
| All checks green (evidence pasted) | ✅ see §2 |
| Working tree clean | ✅ `git status` empty |
| `main` pushed | ✅ `85ed76a..6c42ab4` pushed |

---

## 2. Check commands & results (canonical)

**TS (run from repo root):**
- `npm run typecheck` → ✅ clean (protocol build + connectors + desktop)
- `npm run test` → ✅ **26 tests** (10 connectors + 16 desktop)
- `npm run build` → ✅ vite build OK (CSS 33.12 kB)
- `npm run check` → ✅ (typecheck + test + build + `tauri:check`)

**Rust (run from `apps/desktop/src-tauri`):**
- `cargo fmt --check` → ✅ clean
- `cargo check` → ✅ no errors/warnings
- `cargo clippy` → ✅ no warnings
- `cargo test` → ✅ **24 tests** pass

`npm run tauri:check` = `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`.

---

## 3. Fable rebrand (Phase 1)

Audit found the rebrand was already ~99% complete in the WIP. The single
product-facing stale string was the Tauri bundle identifier.

- **Fixed:** `tauri.conf.json` `identifier`: `com.praxis.workspace` →
  `com.fable.workspace`.
- **Verified intentional (kept):** 3 `App.tsx` "praxis" references are
  backward-compat `localStorage` migration keys (correct behavior — migrating
  old users' data). All other "Praxis" strings are real on-disk filenames
  (QA screenshots, repo dir paths) documented as historical artifacts in
  `README.md`.
- Package names (`@fable/*`), Cargo crate (`fable-desktop`), brand assets
  (`public/brand/`, `FableLogo.tsx`), HTML title, and `docs/brand.md` are all
  consistent and present.

---

## 4. UI overhaul (Phase 3) — acceptance checklist

| Criterion | Evidence |
|---|---|
| No "Utilities" label/group anywhere | ✅ verified `queryByText("Utilities")` is null |
| Knowledge, Automations, Plugins each have own route + page | ✅ `KnowledgePage`/`AutomationsPage`/`PluginsPage` + `activePage` routing |
| Projects and Chats have no leading icons | ✅ `.nav-group-heading--plain` (text + caret only) |
| Profile + Settings in one bottom-left dropdown | ✅ `.sidebar-footer` account popover with both `menuitem`s |
| Composer uses icons + upward dropdowns, no verbose "Voice" | ✅ icon chips; `.composer-menu--up`; no "Voice" text label |
| Composer appears ONLY in chat view | ✅ hidden when `activePage !== null` (render-verified) |
| Every page built out, not placeholder | ✅ each page: `PageHeader` + real panel with fixture content |
| Checks still green | ✅ see §2 |

**Global polish:** refined sidenav spacing/type scale, restrained hero
typography, consistent page chrome (`PageHeader`), responsive breakpoints
updated for the new composer + page layouts.

---

## 5. Module maps

### TypeScript (frontend) — `apps/desktop/src/`
```
App.tsx                     root composition + page/chat routing (192 lines)
main.tsx                    entry (imports styles.css)
data/workspace.ts           desktop-local demo-data ownership boundary
lib/
  constants.ts              STORAGE_KEY, caps, utilityItems
  types.ts                  shell-local types (PersistedShellState, drafts)
  helpers.ts                pure helpers (audit prepend, merge, file read, slug)
  persistence.ts            localStorage + runtime snapshot conversion
  approval-fallbacks.ts     in-browser approval/memory fallbacks
hooks/
  useShellRuntime.ts        all runtime/data state + effects
components/
  WorkspaceSidebar.tsx      shell navigation
  Composer.tsx              Codex-style minimal composer
  ApprovalPanel.tsx         approvals + memory context
  KnowledgePanel.tsx        sources + memory editor
  PluginPanel.tsx           connector manifests
  AutomationPanel.tsx       automation rules
  PageHeader.tsx            shared page chrome
  primitives.tsx            ShellButton, StatusDot, SectionHeading
  workspace-cards.tsx       DirectiveCards, CitationResults, ThreadContext
  FableLogo.tsx             brand lockup
  pages/
    KnowledgePage.tsx
    AutomationsPage.tsx
    PluginsPage.tsx
styles/
  tokens.css shell.css workspace.css composer.css
  directives.css panels.css pages.css responsive.css
  (styles.css is now an @import index only)
```

### Rust (runtime) — `apps/desktop/src-tauri/src/`
```
lib.rs        module declarations + run() command registration (39 lines)
models.rs     constants + all serde wire-format structs
paths.rs      app-data path helpers + text normalization
approvals.rs  approval audit, rules, resolution + 4 commands
knowledge.rs  local-file import + lexical search + 2 commands
memory.rs     memory state, export, promotion + 4 commands
snapshot.rs   runtime snapshot, imported-knowledge, status + 5 commands
tests.rs      24 integration tests (organized by feature, via `use`)
main.rs       binary entry (unchanged)
```

### Connectors — `packages/connectors/src/`
```
index.ts            public barrel (logic + data re-exports; protocol stable)
fixtures.ts         fixture-only catalogs (connectors/directives/threads/...)
local-files.ts      local-file import logic
knowledge-search.ts lexical knowledge-search logic
```

All 15 Tauri command names and public TS protocol types are unchanged.

---

## 6. Commits made this goal

| Hash | Message |
|---|---|
| d756f47 | chore: checkpoint WIP rebrand + architecture scaffolding before goal |
| f0a6274 | feat(brand): complete Fable rebrand |
| 7798338 | refactor(desktop): split App.tsx into shell/composer/panels/hooks |
| e502dc6 | refactor(desktop): document fixture ownership for preview/demo data |
| 03b0739 | refactor(desktop): split styles.css into focused layer files |
| 963b7a5 | refactor(connectors): separate fixture catalogs from logic |
| 0095c42 | refactor(desktop): split lib.rs into focused runtime modules |
| 6c42ab4 | feat(ui): separate Knowledge/Automations/Plugins nav + pages, Codex-style composer |

---

## 7. Deferred (explicitly out of scope — NOT started)

Real GitHub/Vercel/Drive/Slack/Notion/Linear connectors, Convex, voice/
realtime, encrypted SQLite, OS secure storage, automations engine in Rust,
marketing site, CI, release signing. These remain behind their adapter
boundaries with fixture data, as documented in `docs/product/release.md`.

---

## 8. Architecture risks / notes

- The 24 Rust tests and 26 TS tests are the behavior contract; both green and
  unchanged in intent. One test (`recovers shell state from a runtime
  snapshot`) was updated to reflect the intentional Phase 3 change that
  Automations is now a page (composer hidden there) — its intent (snapshot
  recovery of composer draft + automation status) is preserved.
- Connector/plugin pages still render fixture data; "needs-auth" connectors
  show a "Prepare auth" action but perform no real OAuth (by design).
- CSS split was verified rule-equivalent to the original at Phase 2; Phase 3
  then deliberately restyled the composer and added page chrome.
