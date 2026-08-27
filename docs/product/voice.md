# Dictation boundary

Fable's composer supports runtime-detected speech-to-text through the host
browser or operating-system webview API. It is a real integration where
`SpeechRecognition` or `webkitSpeechRecognition` is available and a fail-closed
unavailable state everywhere else. Fable does not ship its own transcription
service.

## User contract

- Empty or whitespace-only composer input shows the dictation action; meaningful
  text shows Send.
- Dictation starts only after an explicit user action.
- Starting, listening, stopping, processing, success, cancellation, permission,
  unsupported, unavailable, and error states are visible and announced.
- Stop adds the final recognized text at the current caret. Cancel or Escape
  discards the active result and preserves the typed draft.
- Settings can disable dictation.

## Privacy and platform limits

Fable does not retain raw audio or persist a separate dictation transcript.
Recognized text becomes ordinary composer text and follows the normal draft and
message lifecycle. The host platform may process speech remotely under its own
policy, which the UI discloses.

Availability is runtime-dependent, including inside Tauri webviews. Unit and UI
tests validate the adapter and state machine; they do not prove microphone or
speech-service support on a particular installed operating system.

## Implementation

- `packages/connectors/src/voice/stt-boundary.ts`: platform adapter, timeouts,
  normalization, and cleanup.
- `apps/desktop/src/hooks/useVoice.ts`: fenced session state machine.
- `apps/desktop/src/components/Composer.tsx`: adaptive action and accessible
  feedback.
- `apps/desktop/src/lib/insert-dictation.ts`: caret-safe transcript insertion.
