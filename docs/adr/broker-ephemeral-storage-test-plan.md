# Acceptance test plan: broker ephemeral durable storage

Linked ADR: [2026-07-03-broker-ephemeral-storage.md](./2026-07-03-broker-ephemeral-storage.md)

**Status:** Proposed — tests are specified here; implementation follows ADR approval.

---

## Test layers

| ID | Layer | Runner | Requires CF credentials |
| :--- | :--- | :--- | :--- |
| L0 | Store interface parity | vitest (`apps/broker`) | No |
| L1 | In-memory DO stub concurrency | vitest | No |
| L2 | Miniflare DO integration | vitest-pool-workers | No (local) |
| L3 | Staging Worker smoke | manual / CI optional | Yes |

---

## L0 — Interface parity (regression)

**Goal:** Durable adapters implement the same contracts as `createStores` / `createRateLimiter`.

| Test | Assert |
| :--- | :--- |
| `pending.create` then `consume` returns entry | Fields match input + `createdAt` |
| `consume` unknown state | `undefined` |
| `consume` expired (clock advanced) | `undefined`; row gone |
| `consume` twice | Second `undefined` |
| `handoff.issue` returns opaque ticket | Length ≥ 32, url-safe |
| `redeem` correct state | Returns tokens + account |
| `redeem` wrong state | `undefined`; second redeem also `undefined` |
| `redeem` expired | `undefined` |
| `rateLimit.check` under limit | `allowed: true` |
| `rateLimit.check` over limit | `allowed: false`, `retryAfterMs > 0` |

**File (proposed):** `apps/broker/src/stores.contract.test.ts` — parameterized over `[memory, durableStub]`.

---

## L1 — Concurrency (deterministic)

**Goal:** Prove consume-once under parallel callers.

| Test | Setup | Assert |
| :--- | :--- | :--- |
| `pending_consume_single_winner` | One `putPending`; `Promise.all` 10× `consumePending` | Exactly **1** success; 9 misses |
| `handoff_redeem_single_winner` | One `issueHandoff`; `Promise.all` 10× `redeemHandoff` | Exactly **1** success |
| `pending_provider_mismatch_deletes` | Put `github`; consume as `slack` | `undefined`; subsequent `github` consume misses |
| `handoff_state_mismatch_burns_ticket` | Issue; redeem wrong state | `undefined`; correct state redeem misses |

**File (proposed):** `apps/broker/src/durable-stores.concurrency.test.ts`

---

## L2 — Encryption and observability

| Test | Assert |
| :--- | :--- |
| `handoff_payload_not_plaintext_in_do` | Raw SQLite / storage snapshot has no `access_token` substring |
| `verifier_not_plaintext_in_do` | Pending row `verifier_enc` ≠ UTF-8 verifier |
| `aad_swap_fails_decrypt` | Ciphertext moved to different `stateHash` → redeem/consume miss |
| `log_redaction` | Adapter log hook never receives 20+ char base64url handoff or `Bearer` |

**File (proposed):** `apps/broker/src/store-crypto.test.ts`

---

## L2 — Broker E2E (durable backend)

Re-run existing `broker.test.ts` scenarios with `FableBroker` wired to durable stub:

| Existing describe block | Must pass unchanged |
| :--- | :--- |
| `broker callback + handoff` | All 7 tests |
| `broker token redaction invariant` | All |
| `broker provider coverage` | All 5 providers |

Additional:

| Test | Assert |
| :--- | :--- |
| `callback_cross_isolate_simulation` | Authorize on broker instance A stub; callback on B stub sharing same DO id → success once |
| `storage_backend_memory_default` | Worker config without env → memory stores (no DO stub calls) |

---

## L2 — Rate limit (cross-isolate)

| Test | Assert |
| :--- | :--- |
| `ratelimit_shared_across_stubs` | Two stubs same `route:peer` DO; combined requests exceed limit → 429 on router |
| `ratelimit_isolated_peers` | Different peers independent budgets |

**File (proposed):** `apps/broker/src/router.durable.test.ts`

---

## L3 — Staging smoke (external validation)

Manual checklist before production `FABLE_BROKER_STORAGE_BACKEND=durable`:

1. Full GitHub OAuth on staging desktop against staging broker.
2. Deliberate double-open callback URL → second attempt shows `invalid-state`; provider token exchanged once (verify provider audit if available).
3. Wait 61s before redeem → `invalid-handoff`.
4. Worker Analytics / log drain: confirm no `access_token`, `refresh_token`, `client_secret`, full `state`, or `handoff` values.
5. Rollback: flip to `memory`, confirm authorize still works (with known isolate limitation documented).

---

## Pass criteria

- All L0 + L1 + L2 tests green in CI without credentials.
- L3 completed once per environment before first production durable enablement.
- No new public routes; `BrokerEndpoints` desktop resolver unchanged.