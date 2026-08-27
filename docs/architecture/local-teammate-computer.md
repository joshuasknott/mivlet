# Local teammate computer

> [!IMPORTANT]
> **Status: real browser and persistent-file foundation implemented; full local
> computer isolation is partial.** This document distinguishes the working
> boundary from the intended container/VM backend.

## What works now

For every local workspace and named agent, Fable derives one opaque native
computer identity and a private directory below Fable's application data. The
scope contains:

- `workspace/` for persistent files exposed to the agent's approved read/write
  tools;
- `browser-profile/` for a persistent Edge/Chrome/Chromium profile; and
- `downloads/`, reserved inside the same scope for bounded future download
  support.

The native app can start a separate browser process for the scope, target a
1280 by 800 viewport, measure the browser's actual scaled viewport, capture an
ephemeral screen, and show it inside Fable. Different agents have
different directories, profiles, processes, session locks, and control
generations. Browser work runs off Fable's async UI runtime so one slow page does
not block unrelated agents or the desktop shell.

The user can take control, click, scroll, and type a deliberately small key set,
then return control. Every control transition increments a generation. Input
from an old frame or before takeover fails closed. Keys go directly from the
focused screen to the native browser command and are not placed in React state,
the conversation, SQLite, or ordinary logs.

While the user holds control, bounded Back and Forward actions target only the
browser's current native navigation-history entries. Availability is projected
with each ephemeral frame, and every move is fenced to the current browser
generation; stale, unavailable, or agent-controlled requests fail closed.

The trusted Fable UI can list up to 200 relative workspace entries, including
folder/file kind and file size. It never receives host paths or file contents,
does not follow symlinks or junctions, and marks depth or entry truncation
explicitly. This view remains available when the private browser is stopped.

Selecting a regular file can request an ephemeral, UTF-8-only text preview of
up to 256 KB. The native boundary re-confines and canonicalizes the selected
relative path, rejects links, directories, binary/control content, and path
escapes, and never returns the host path. Preview content remains in transient
trusted UI state and is not copied into model context, logs, or durable runtime
records.

An approved `local-browser` agent tool can start the already-provisioned browser
after an app restart and navigate it to one credential-free HTTP(S) address.
Agent navigation also rejects authorization-, credential-, and session-shaped
query parameters; the user can take control to complete provider sign-in.
The model receives only the observed final origin, bounded title, opaque
computer ID, and timestamp—not user information, path, query, fragment, screenshot, page
contents, profile, cookies, or process details. A separate approved observation
tool returns at most 40 visible named controls with bounded role/name/action
metadata. Native single-select controls may additionally expose up to 50
visible, enabled option labels, never their internal values. Password, passcode,
verification, token, API-key, and payment-shaped fields are omitted. Exact,
single-use refs support click, non-secret fill, exact-label native selection,
and a small key allowlist; refs expire after navigation, takeover, or any
attempted action. Duplicate labels and changed controls fail closed. All agent
browser actions fail closed while the user has taken control.

After an app restart the directories and browser profile remain, but the browser
process does not. Fable shows **Start** and launches it again with the existing
profile. The app currently needs to remain open for this local browser process
and local agent turns to continue.

Before each new agent navigation or observation, the native boundary checks that
the retained Chromium target still responds. A lost connection is replaced
behind the same per-agent launch gate. Replacement sessions advance the previous
control generation and return to agent control, so input from a stale human frame
cannot target the new process. If screen polling loses contact first, Fable hides
the broken browser controls and presents an explicit retry rather than continuing
to show the session as usable.

New local Routines record one exact teammate identity in their native version.
While Fable remains open (including when its window is minimized), the native
scheduler detects due and missed occurrences and the dedicated headless runner
uses that teammate's current instructions, learned responsibilities, selected
model, and tool executor. Approved file and browser calls are therefore scoped
to the same private local computer as interactive work. A deleted teammate or
an unavailable matching provider/model blocks the occurrence instead of
silently running it as another teammate. Imported legacy schedules have no
teammate binding until they are edited and are labelled accordingly in the UI.

## File and process boundary

Approved `read-file` and `write-file` actions resolve their root from the native
workspace/agent identity. The renderer cannot supply a host path, and native
path confinement rejects absolute paths, traversal, and symlink escape.

Local `run-shell` never falls back to `cmd`, PowerShell, or the user's host shell.
It fails before asking for an approval and is also rejected at the Rust boundary.
Command execution is available only through a separately configured isolated
hosted computer today. A future local terminal must use a real container or VM
backend before it can be enabled.

## Browser and sign-in boundary

Fable discovers a supported installed browser or an explicitly configured
absolute Chromium executable. It launches with:

- a profile dedicated to the workspace/agent scope;
- Chromium's browser sandbox enabled;
- certificate-error bypass disabled; and
- no DevTools URL, cookie, token, filesystem path, or process handle returned to
  the renderer.

Websites can present their normal sign-in flow inside the isolated browser.
Compatibility with provider-specific OAuth redirects, passkeys, and anti-bot
checks has not yet been certified. Fable does not
scrape cookies, copy private session tokens, or translate a browser session into
an application credential. The browser profile relies on the browser and host
operating system's profile protection; Fable does not yet add a second
application-layer encryption envelope around Chromium's profile files.

## Working security properties

- Credential-bearing URLs and non-HTTP(S) schemes are rejected. Agent-directed
  URLs additionally reject secret-shaped query keys.
- Screenshots are bounded to 4 MB and are ephemeral renderer data.
- Browser operations are serialized per agent, while different agents can run
  independently.
- Concurrent setup requests share a per-agent launch gate and cannot create
  duplicate retained sessions.
- Lost Chromium connections are replaced on the next setup or agent browser use;
  the replacement advances the control generation before accepting input.
- Browser/process handles and private paths never cross the native IPC boundary.
- File operations retain Fable's existing exact approval, permit-consumption,
  audit, size-limit, and path-confinement checks.
- Agent navigation requires a critical, exact, one-time approval that Rust
  re-validates and consumes before opening the canonical URL.
- Control observations are explicitly marked external-untrusted, omit page body
  text and secret-shaped fields, and are single-use for exact approved actions.

## Remaining work

- Container or VM isolation for applications, a terminal, processes, networking,
  and resource quotas on Windows, macOS, and Linux.
- Broader model-facing page understanding, downloads/uploads, tabs, and
  submit-specific policy beyond the current bounded named-control
  actions.
- File editing, bounded downloads/uploads, multiple tabs/popups, clipboard,
  passkeys, proactive crash telemetry, and preservation of in-progress page state
  across a browser-process failure.
- Teammate-bound local Routines run through the dedicated headless workflow
  driver while Fable remains open. Automatic continuation of ordinary chats
  and execution after the desktop app closes are still missing, followed by a
  carefully separated optional always-on cloud placement.
- Stronger profile-at-rest protection, retention/deletion controls, resource
  budgets, monitoring, and installer/updater validation.

## Verification

Pure native tests pin scope derivation, traversal-resistant identity validation,
URL policy, directory confinement, and file-root isolation. An ignored live
integration test launches the installed Chromium browser, navigates to a local
HTTP page, types into a real input, and captures a JPEG frame. A second live test
uses the agent navigation path and verifies it returns only the bounded metadata
projection. A third observes real controls, verifies a password field is
omitted, fills the exact observed textbox, and chooses a native option by its
visible label without exposing its internal value. They are ignored in portable CI
because a browser installation is an external prerequisite, and are run
explicitly on supported desktop hosts.
