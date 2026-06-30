# Linear production connector

Fable's desktop runtime uses Linear's OAuth 2 authorization-code flow. OAuth credentials, including access tokens, refresh tokens, and revocation state, are stored securely within the native OS keyring boundary. The UI and LLM layers never receive or store these credentials directly.

## Auth broker and callbacks

Like GitHub, Vercel, Notion, and Slack, Linear is a confidential client requiring client secrets that must not live in the desktop binary. It uses the Cloudflare Workers auth broker (`apps/broker`). Until the broker is deployed and callback URLs are configured in the Linear developer console, the Linear connector fails closed with `configuration-required`.

Configure `FABLE_AUTH_BROKER_URL` to point to a broker implementing:
- `GET /oauth/linear/authorize`
- `GET /oauth/linear/callback`
- `POST /oauth/linear/handoff`
- `POST /oauth/linear/refresh`
- `POST /oauth/linear/revoke`

Requested scopes: `read`, `write`, `issues:create`, `comments:create`.

## Implemented API operations

The Linear connector interacts with Linear's GraphQL API (`https://api.linear.app/v1/graphql`) directly from the desktop.

### Read capabilities
- **Viewer Identity (`identity.read`)**: Resolves current user ID, name, email, avatar, and organization.
- **Teams (`teams.read`)**: Lists teams in the workspace with pagination.
- **Projects (`projects.read`)**: Lists projects with their state, progress, and team mappings.
- **Cycles (`cycles.read`)**: Lists cycles filtered by team.
- **Issues (`issues.read`)**: Retrieves a single issue's details (identifier, state, assignee, labels, project, cycle) or lists all issues.
- **Issue Search (`issues.search`)**: Searches issues using a keyword query.
- **Comments (`comments.read`)**: Retrieves comments on a specific issue.
- **Labels (`labels.read`)**: Lists issue labels.
- **Users (`users.read`)**: Lists workspace users.

### Write capabilities (Consequential)
- **Create Issue (`issues.create`)**: Creates a new issue under a team.
- **Update Issue (`issues.update`)**: Updates issue details (state, assignee, description, etc.).
- **Create Comment (`comments.create`)**: Appends a comment to an issue thread.

Every external write is classified as consequential and requires a fresh, per-action Fable user approval detailing the proposed changes before execution.

## Implemented Connector State Behaviors

The Linear connector handles standard states as follows:
1. **Configured**: Active connection with access and refresh tokens stored in the OS keyring.
2. **Unconfigured**: If the broker returns HTTP 503 `configuration-required`, the connector fails closed.
3. **Expired**: If a token refresh fails with HTTP 401 `needs-auth`, a missing refresh token error occurs, or the Linear API returns `AUTHENTICATION_ERROR` (mapped to status 401), the state updates to `expired-auth` asking the user to reconnect.
4. **Revoked**: Disconnecting the connector triggers revocation via `/oauth/linear/revoke` handling HTTP 200 (success) and HTTP 404 (idempotent success).
5. **Refresh Failure**: If the broker refresh returns HTTP 500, it maps to `provider-unavailable` with `retryable: true`.
6. **Missing Broker**: If the broker is offline (network error) or returns HTTP 404, it propagates the failure or throws `not-found`.
7. **Provider Unavailable**: Direct API requests returning HTTP 502, network socket errors, or malformed responses map to `provider-unavailable` with `retryable: true`.
