# User-owned Instabox computers

Status: **draft integration, not accepted for agent computer work**. Mivlet
connects directly from the native Windows client to the user's Instabox account.
There is no Mivlet compute account, resale, hosted proxy, or model-provider link.
Existing agents continue to use This PC until the user chooses otherwise.

## Connection and machine lifecycle

Settings → Computers separates This PC from Instabox. API-key entry happens in
the existing protected native Windows dialog with local computer input/capture
fencing. The renderer never receives the key. Native custody is separate from
model-provider credentials; the encrypted local store contains only connection,
selection and operation metadata. There is no browser key-entry fallback.

Account validation is read-only. Machine creation is a separate explicit action
and uses the standard Linux template without copying local files, provider
credentials, browser profiles, or Instabox Vault secrets. Account/API entitlements
are authoritative; the UI does not promise a free machine or hardcode marketing
quotas. Existing machines may already contain the user's files and remote
website sessions.

Selection is an exact machine ID and connection revision. Pause preserves remote
processes; it is not process termination. Disconnect removes Mivlet's key and
preserves the remote machine, files and recovery evidence. It is not deletion or
provider-side key revocation. Revoke a key through Instabox to invalidate other
copies of that key.

## Agent boundary

A saved agent preference is independent of its model. Work captures its computer
choice, rather than reading a mutable agent setting throughout an active task.
A cloud choice must not fall through to local file staging, local tools, the
Cloudflare hosted computer, or a provider's own host-shell tools. Unsupported
routes fail closed. A missing/invalid cloud selection requires recovery, not an
implicit switch back to This PC.

The current adapter does **not** advertise remote process execution, agent desktop
input, or file/artifact transfer. No local workspace, chat history, local browser
session or model credential is uploaded to Instabox by this integration.

This restriction is deliberate and material. Instabox's HTTP file-read endpoint
runs as root/sudo and follows symlinks. A `cwd` prefix or separate directory is
not a confidentiality boundary. The standard VM contract also lacks documented
enforced per-agent network egress and privilege restrictions. A shared machine
therefore cannot safely substitute for Mivlet's restricted native execution
runtime merely by assigning different directories. Machine serialization would
prevent simultaneous input, but would not solve access to another agent's files.

Enabling those capabilities requires a verified remote supervisor with enforced
identity, per-agent filesystem/credential boundaries, egress rules, bounded
process groups/output, exact single-use approvals and a persistent per-machine
lease. Approved transfer needs sealed local inputs and verified bounded output
receipts with provenance. None of these capabilities is inferred from a mocked
API response or the existence of a Linux VM. Until implemented and accepted,
there is no runnable agent queue for remote machine capacity.

## Recovery and lifetime

Mivlet owns the agent loop; Instabox owns the VM. This integration does not
establish cloud-resident agent continuation after Mivlet closes or crashes.
Remote processes and files may survive client exit and machine pause. Local
Stop cannot be described as acknowledged remote termination without a confirmed
provider result.

Lifecycle writes record their request identity before transmission. Recovery
checks the operation ID or the same bounded idempotent lifecycle request; it
must never turn an unknown write outcome into a fresh operation. Instabox exec
is non-idempotent, which is another reason it is not exposed through this
initial adapter. A stale record outside the provider's idempotency retention
needs manual reconciliation, not replay.

Desktop viewing uses a native child WebView and a short-lived view-only stream.
The bearer URL stays in native memory. React receives safe status and supplies
panel geometry. Closing the viewer fences it locally before revocation; an
unconfirmed revoke remains retryable while that native process is alive.
Instabox's revoke endpoint invalidates
all desktop streams for the machine, including other clients; the panel discloses
that scope. There are no interactive takeover controls in this draft. A future
input-capable viewer must retain human ownership
until explicit Return control, regardless of Instabox's automatic handback timer.
Native navigation/guest IPC isolation and real stream closure still require live
acceptance.

Link expiry only prevents new connections. A session opened before expiry may
continue until the viewer leaves or Instabox acknowledges revocation. The
60-second link lifetime is therefore not proof that an open remote session has
ended.

Orderly exit and account restart destroy the outgoing account's WebView and
fence its viewer before attempting remote revocation with the captured native
key. The attempt is bounded to five seconds, including time waiting for another
viewer operation. Failure or timeout does not establish provider-side closure.
Forced termination, a crash, or an unavailable network can still leave remote
revocation unconfirmed; that state is not persisted for automatic replay after
restart. A missing native child is reported as closed, with an explicit retry
available if its remote revoke was not acknowledged. Repeated status reads do
not replay that failed revoke.

## Sources and acceptance

The official [OpenAPI](https://api.instabox.sh/v1/openapi.json),
[account API](https://instabox.sh/docs/api/account),
[machine API](https://instabox.sh/docs/api/machines),
[lifecycle API](https://instabox.sh/docs/api/lifecycle),
[commands/files API](https://instabox.sh/docs/api/commands), and
[desktop guide](https://instabox.sh/docs/desktop) were inspected on 21 October
2026. The API contract, account responses and real acceptance take precedence
over older marketing limits.

No suitable live Instabox account/key was supplied to this task. Do not enter a
key in chat or a browser fixture. Live acceptance must use protected native entry
and a suitable user-owned account; it must cover select/create, lifecycle result
reconciliation, revoked keys, restart, disconnect, viewer isolation and Stop
viewing. Takeover/return and agent operation/file journeys remain blocked by the
restricted-runtime prerequisite above. Do not merge or advertise end-to-end
cloud computer capability on the basis of unit or component tests.

### Acceptance attempt on 22 October 2026

The user confirmed that no suitable Instabox account is available. Live key
validation, machine selection/creation, lifecycle reconciliation, revoked-key
recovery and provider-confirmed stream termination remain blocked on that
prerequisite. Do not substitute a fixture or create a paid machine to fill it.

The public OpenAPI was refreshed on this date. Its link-expiry and machine-wide
revocation semantics informed the shutdown checks; a schema read is not evidence
of an authenticated provider response or successful stream termination.

Windows Computer Use also failed before initialization with
`failed to write kernel assets: The system cannot find the path specified.
(os error 3)`, including after resetting its JavaScript session. Consequently,
protected native entry, actual child-view placement/accessibility and guest IPC
isolation were not observed interactively in this attempt. This tool failure is
distinct from a defect demonstrated in the application.

Once a suitable account and native inspection are available, acceptance must
cover cancel/invalid key entry, select/create, pause/resume, uncertain lifecycle
recovery, Stop viewing and failed-revoke retry, account restart, normal exit,
abrupt exit/reopen, disconnect, and the guest navigation/IPC boundary. Verify old
stream revocation from a separate client; expiry alone does not establish it.
Record the exact executable/renderer revision and distinguish unsigned native
builds from installer or clean-machine evidence. The integration remains draft.
