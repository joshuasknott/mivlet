# Linear production connector

Linear is a confidential-client provider: its OAuth exchange happens at the
auth broker and the desktop performs direct GraphQL reads and approval-gated
writes with a token resolved by the native credential boundary. OAuth state,
PKCE verifiers, access tokens, refresh tokens, and revocation material are
stored only through the native OS keyring boundary; the React and TypeScript
layers never receive stored credentials.

## Auth broker and callbacks

The auth broker is implemented in `apps/broker` (targeting Cloudflare Workers
for production deployment) but is not yet deployed in production. The full
broker contract — including the non-proxying boundary, the fail-closed
configuration checks, and the local-first guarantees — is documented in
[Auth broker contract](auth-broker.md). The desktop fails closed for Linear
until a broker is deployed and configured.

Set `FABLE_AUTH_BROKER_URL` to the HTTPS base URL of a broker that owns the
Linear client secret and implements:

- `GET /oauth/linear/authorize`
- `GET /oauth/linear/callback`
- `POST /oauth/linear/handoff`
- `POST /oauth/linear/refresh`
- `POST /oauth/linear/revoke`

The desktop starts OAuth with PKCE and an exact HTTPS or loopback callback.
Register the broker's provider callback in the Linear OAuth application; the
broker redirects a single-use handoff ticket and state to the exact desktop
redirect. Local broker URLs may use `http://127.0.0.1` or `http://[::1]`;
production must use HTTPS.

## Linear

Create a Linear OAuth application and select the workspace scopes the
connection should grant. Typical read scopes cover workspace metadata, teams,
projects, cycles, issues, comments, labels, and users. Issue create/update and
comment write scopes (`issues:create`, `comments:create`) are requested only
when approved issue/comment mutations are enabled. Linear only returns the
data the connected workspace grants the application.

Implemented read operations (all over the Linear GraphQL API, Relay-paginated
where the provider supports it):

- **workspace/user identity** — the `viewer` and organization;
- **teams** — team list with key, name, and description;
- **projects** — project list with state, progress, and owning teams;
- **cycles** — cycles scoped to a team (`teamId` is required);
- **issues** — issue list (ordered by `updatedAt`) and a single-issue read
  when an `issueId` is supplied, including state, assignee, team, project,
  cycle, and labels;
- **issue search** — `searchIssues` term search;
- **comments** — paginated comments for an issue (`issueId` is required),
  with author and timestamps;
- **labels** — workspace issue labels;
- **users** — workspace members.

Implemented write operations (approval-gated only): create/update issues and
create comments. Every mutation requires a fresh per-action Fable approval and
fails closed without one; a mutation the provider rejects (`success !== true`)
surfaces a normalized error. Model-generated content is never written
automatically.

Provider errors are normalized to Fable connector codes. GraphQL extension
codes map as follows: `RATELIMITED` → rate-limited (retryable),
`AUTHENTICATION_ERROR` → expired-auth, `FORBIDDEN` → permission-denied, and
anything else → invalid-request. HTTP statuses and network failures map
through the shared provider error boundary. The bearer token travels only in
the `Authorization` header, never in the URL or GraphQL variables.

## User-safe result shapes

Linear exposes the same pure shaping helpers as the Slack, Notion, and Vercel
connectors so the UI and model layers consume a normalized result:

- `normalizeLinearItem(LinearPayload)` → `ConnectorSearchItem`;
- `shapeLinearSearch(query, limit?)` → a normalized `ConnectorSearchRequest`;
- `mapLinearError(error)` → a safe `ConnectorError`.

These helpers never touch the network or credentials.

## Development and tests

Production paths never fall back to fixtures. Deterministic fixtures and
mocked GraphQL responses are test-only. The adapter is covered by a dedicated
suite (`packages/connectors/src/providers/linear.test.ts`) exercising every
read capability, Relay cursor pagination, required-argument validation,
GraphQL and HTTP error normalization, cancellation, token redaction, the
broker auth contract, and approval-gated writes. Live tests are opt-in through
`FABLE_LIVE_CONNECTOR_TESTS` and must obtain deliberately supplied credentials
through the native credential boundary; credentials and provider content must
never be committed or logged.

Use `pnpm check` plus `cargo test`, `cargo fmt --check`, and
`cargo clippy -- -D warnings` before integration. Provider console creation,
public distribution/review, and production broker deployment remain external
release work.
