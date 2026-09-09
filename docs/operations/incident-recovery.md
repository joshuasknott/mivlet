# Incident and recovery guide

This guide covers repository and local-development response. Production remote
service response remains provisional until those services are deployed with
owners, telemetry, backups, and access controls.

## First response

1. Stop the affected Mivlet process or optional service when continued activity
   could worsen the incident.
2. Preserve the exact checkout, logs already produced, timestamps, versions,
   database/WAL set, installer hash, and affected workspace/teammate identity.
   Do not copy credentials or decrypted user content into an issue.
3. Classify the boundary: provider/Connection credential, encrypted store,
   approval/effect, local computer, account/sync, hosted runner, or release.
4. Revoke exposed credentials and capabilities at their owning provider before
   attempting application repair.
5. Use a clean checkout and known-safe build for diagnosis. Do not overwrite the
   only copy of an affected database or Docker volume.

## Provider or Connection credential exposure

- Disconnect or revoke the exact provider/account credential at its source.
- Clear the matching Mivlet secure-store reference through the supported UI or
  native recovery path; do not delete unrelated credential-store entries.
- Inspect redacted action history for the affected Connection and time window.
- Reconnect only after the cause is fixed. A successful local fixture or model
  list does not prove the credential is safe.

## Encrypted database failure

- If startup reports corruption or a missing/wrong vault key, stop repeated
  write attempts.
- Preserve `fable-vault.db` with its WAL/SHM companions, or use a previously
  completed native backup. Never copy only an active base database.
- Restore only through the native validation path, which checks the manifest,
  schema, integrity, and vault marker before replacement.
- Keep failed-restore and pre-restore files until recovery is confirmed.
- If the vault key is permanently lost, ciphertext cannot be recovered. Do not
  silently generate a replacement key over the existing store.

## Incorrect or repeated external effect

- Stop the active conversation and revoke the relevant Connection or hosted
  capability.
- Preserve the proposal fingerprint, approval decision, internal execution
  attempt, tool call, audit correlation, and provider-side event ID if available.
- Determine whether the defect was proposal construction, approval binding,
  permit consumption, transport retry, or provider idempotency.
- Add a negative replay/freshness test before restoring the effect path. Never
  repair by weakening the approval assertion.

## Local teammate computer incident

- Return control if possible, then stop the exact labelled container. Do not
  remove a container or volume until its scope labels have been verified.
- Preserve the container inspection, image ID, bounded logs, and affected scoped
  workspace. Treat files and browser state inside the volume as sensitive.
- If the image is suspect, rebuild from a clean checkout and replace the
  container. Retain or discard the persistent volume only through an explicit
  user decision because it contains the teammate's Linux home and browser
  profile.
- An incident in one container does not justify deleting unrelated teammate
  volumes or the user's Docker installation.

## Optional account, sync, or hosted incident

- Revoke the affected session, device, HMAC/root secret, and active capabilities
  at the authoritative service.
- Disable remote writes or hosted provisioning while preserving local work.
- Check workspace scoping, current membership/device state, idempotency records,
  capability nonce consumption, computer generation, and network-policy logs.
- Do not infer tenant impact from local fixtures. A production declaration
  needs live service evidence and provider logs.

## Release incident

- Record installer hash, source commit, Rust/Node/toolchain versions, signing
  state, and install path.
- Stop distribution of the affected artifact. Do not claim an updater rollback
  when no supported updater channel exists.
- Rebuild from the exact clean source, run the full gates, install on a clean
  test account or machine, and smoke the real native app before replacement.

## Closure

An incident is closed only when the cause and affected boundary are known,
credentials/capabilities are rotated where needed, data recovery is verified,
the regression is covered by focused tests, broad gates pass, and user-facing
limitations or recovery steps are documented truthfully.
