# Grok Bot (Experimental)

Mivlet connects to existing persistent Bots through a private paired bridge.
This uses the connected **Grok Bot account's allowance**. It does not use the
xAI API, Grok CLI, `grok_ask`, or a Cursor subscription. Mivlet has no balance
or spending endpoint: the livestream promotional $200 allowance and its
consumption remain unverified until observed in that account.

Open **Connections → Grok → Grok Bot (Experimental)**. This dedicated view
supports connection checks, discovery, exact Bot selection, remote text history,
one-shot sends, serial observation, history pagination, and disconnect/reconnect.
It is also reachable from required provider setup, without connecting a paid API.
Bots are remote agents, so this view does not create model IDs or clear the main
workspace's model-provider onboarding gate. Conversations remain in Grok Bot;
opening this view again requires reconnecting and selecting the Bot. Mivlet does
not import these snapshots into local chats, agents, memory, schedules or exports.
Existing Grok CLI and xAI API connections are unchanged.

## Verified source and compatibility

Inspected on 2026-09-19:

| Reference | Evidence and decision |
| --- | --- |
| [codex-grok-mcp](https://github.com/Fato07/codex-grok-mcp/tree/a78fa0ac876bec756e373deacbd55cb98e018e55) | MIT; use published `0.2.0-beta.8`, Git tag/commit `a78fa0ac876bec756e373deacbd55cb98e018e55`. npm's `gitHead` matches. |
| Advertised `0.2.0` | README/source checkout at `fe1d52c5d2611512e5c805c405fe432b43455a5a` advertises it, but neither npm nor GitHub has a stable version/tag/release. Do not install the advertised stable version. |
| npm archive | `sha512-6ouDfYiCBON1O9RS6t7A64AiJa6YlgvMW1g/8XPYqS5hkowBVJtYnQicNXLTQvM5dIYBqOqxpFkGzHE975IgDQ==`; the installer checks these exact bytes before installation. |
| [MaisonnatM/grok-bot](https://github.com/MaisonnatM/grok-bot/tree/57c8fc53fdf5f5791134b9382fdddbb235e4923e) | MIT Raycast extension. `src/lib/gateway.ts` confirms undocumented gateway POST/send acceptance; it is not an official Windows SDK and is not bundled or called. |
| [Official Grok Bot overview](https://docs.x.ai/grok-bot/overview) | Product context, not an official third-party OAuth or gateway contract. |

The pinned bridge's `src/bridge-pairing.ts` requires `process.getuid()` and
POSIX ownership/modes (`0700` directory, `0600` pairing file). Native Windows
fails these checks. **WSL with a Linux filesystem is required**; do not put
pairing files under `/mnt/c` or weaken its permission checks. Mivlet invokes only
the pinned MCP entry point via a fixed WSL launcher. It never downloads packages
when connecting and never falls back to a different billing route.

## Setup

Prerequisites: an existing Grok Bot account and at least one non-group Bot;
access to its Computer terminal; a Cloudflare account for your private relay;
WSL with a Linux distribution; Node 22+ and npm inside WSL, with Node available
at `/usr/bin/node`. The relay is your deployment and may incur Cloudflare costs.
No credentials or relay have been provisioned by this PR.

1. Install WSL/your Linux distribution if necessary (`wsl --install` from an
   administrator PowerShell; follow Windows' restart instructions). Check
   `wsl --list --verbose`. Use the same default distribution and Linux user for
   setup and Mivlet. Install Node 22 using your distribution's supported method,
   then verify `/usr/bin/node --version` and `npm --version` in WSL.
2. From WSL, install the pinned code using the checked-in helper (adjust the
   checkout path if needed):

   ```sh
   sh '/mnt/c/Users/Joshua Knott/Projects/mivlet-grok-bot/scripts/providers/install-grok-bot.sh'
   ```

   The helper checks the npm archive hash, disables lifecycle scripts and
   installs the package with its published shrinkwrap. Existing installations
   are not overwritten. Keep the MIT license in the installed package.
3. In Mivlet, sign in, open the Grok Bot connection, expand **Set up the bridge**,
   and copy the displayed `export XDG_CONFIG_HOME=...` line into your WSL
   terminal. The hash binds pairing to this Mivlet account/workspace. Do not
   substitute the general Codex pairing directory or another Mivlet scope.
4. In that same WSL terminal, deploy the bundled relay:

   ```sh
   BRIDGE="$HOME/.local/share/mivlet-grok-bot/0.2.0-beta.8/node_modules/codex-grok-mcp"
   cd "$BRIDGE/relay"
   npm ci
   # Complete your Cloudflare sign-in locally when Wrangler requests it.
   RELAY_TOKEN="$(/usr/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
   printf 'RELAY_ACCESS_TOKEN=%s\n' "$RELAY_TOKEN" | npx wrangler deploy --secrets-file /dev/stdin
   ```

   Follow the pinned relay's README for account/domain prerequisites. Do not
   enable request logging or share this single-operator relay. Retain the token
   in a password manager if needed for recovery; never paste it into Mivlet chat.
5. Pair from the **same WSL terminal**, replacing the relay URL with the deployed
   worker's address:

   ```sh
   CODEX_GROK_RELAY_TOKEN="$RELAY_TOKEN" /usr/bin/node "$BRIDGE/dist/index.js" pair --relay-url wss://YOUR-WORKER.workers.dev/v1/connect
   unset RELAY_TOKEN
   ```

   The pairing code is private. In Grok Bot's **Computer terminal**, not a Bot
   conversation, run:

   ```sh
   npx --yes --package=codex-grok-mcp@0.2.0-beta.8 -- codex-grok-bridge probe
   npx --yes --package=codex-grok-mcp@0.2.0-beta.8 -- codex-grok-bridge connect
   ```

   Paste the code only into its no-echo prompt. Keep the companion running.
   For subsequent VM restarts use the same exact version's `codex-grok-bridge run`.
6. Click **Connect bridge**, select the exact Bot and inspect its existing
   history. Send a distinctive, harmless message once. Watch for new remote
   text; compare it with Grok Bot itself. Check the account's allowance display
   there before and after usage to establish whether promotional credit applies.
   A balance decrease alone may include other concurrent Bot activity.

Disconnect and **Stop watching** revoke the local connection and discard late
results. They do not send a cancellation command: the bridge has none. A Bot may
continue running, including consuming allowance. Stop remote work in Grok Bot.
Closing this view also disconnects locally. Reopen and reconnect to retrieve
current history; no message is replayed. Pairing remains in the provider-owned
WSL directory. To remove it, use the same `XDG_CONFIG_HOME` and
`/usr/bin/node "$BRIDGE/dist/index.js" unpair` in WSL and the pinned companion's
`unpair` in the VM. Revoke/decommission your relay separately if required.

## Boundaries and recovery

- The dedicated adapter contract is `RemoteBotTransport`, not `AgentBackend`.
  Existing agent backends promise model turns, streaming and Mivlet tool
  mediation; wrapping a remote Bot in that contract would misrepresent it.
- Native Rust owns process creation, account validation, workspace selection
  freshness, exact discovered Bot IDs and single-use send nonces. The launcher
  clears provider environment variables and uses an account/workspace-specific
  provider configuration directory. Pairing/gateway credentials never enter
  React, model transcripts, logs or Mivlet exports.
- MCP uses bounded stdio request/response framing, initialize, and only
  `grok_bridge_status`, `grok_list_bots`, `grok_read_bot` and
  `grok_send_bot_message`. There is no arbitrary MCP dispatch or tool access
  granted to the Bot. The general MCP connector permission system governs
  Mivlet-executed tools; it cannot govern remote Grok Bot actions.
- Sends happen once. Timeout, disconnect, malformed receipt or lost response
  means the outcome may be unknown. The draft is cleared before sending and
  there is no resend/retry button or recovery replay. Inspect Grok Bot before
  manually composing another message. A disconnected send may have arrived.
- Acceptance is only gateway acceptance. Idle is only an activity observation.
  Waiting-for-user, working and unknown are separate. No completion event or
  automatic local completion notification is generated.
- The bridge omits stable message IDs and does not claim response correlation.
  Mivlet shows a bounded source-history page and replaces it on refresh, instead
  of appending poll results or deduplicating identical text. Real duplicate
  source entries remain visible. Other clients may write to the same Bot.
  Pagination and truncation remain explicit; old pages pause automatic refresh.
- No attachments, token streaming, model picker, local-agent instructions,
  remote cancellation or spending telemetry are advertised. All text remains
  untrusted external content, rendered as text without executing remote HTML.
- Setup errors require WSL, the exact version at both ends, matching scoped
  pairing, a reachable relay and an active companion. There is no direct gateway
  fallback. After a failed native request, reconnect before further work.

## Validation

Focused fixture tests cover single-attempt uncertain sends, malformed acceptance,
duplicate snapshots, pagination races, target changes, late connect/send/read
results, disconnect semantics, pinned companion health and native stdio framing.
UI and native checks are recorded in the PR. These checks do not prove live
WSL pairing, relay routing, VM compatibility, remote answers or billing.

Live acceptance remains blocked on user-owned WSL/relay/VM pairing and account
access. After setup, verify discovery and send/read against the real Bot, remote
waiting states, disconnect while sending, reconnect without duplicate sends,
companion loss and account switching. Record only redacted outcome/version
evidence, never pairing codes, credentials or private conversation content.
