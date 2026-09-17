# Speech input

Mivlet currently offers dictation only. Voice-to-voice calls, automatic spoken
turns, and generated speech are not available.

The microphone sits immediately left of Send. Send is visible but disabled for
an empty draft without attachments. Dictation fills the current draft; it does
not submit it. Existing agent Stop and tool approvals retain their authority.

## Dictation boundary

`useComposerVoice` and `useVoice` own the composer recording flow. Users review
recordings before authorizing upload for OpenAI transcription. Native
`native_speech` validates the recording and uses the separately connected API
credential from secure storage. Cancel, account changes, and composer scope
changes retain their existing cancellation and freshness fences.

The removed call UI, speech playback pipeline, automatic turn detector, and
native voice-call commands must not be used as evidence of available features.
Any future voice conversation implementation needs its own design and live
Windows audio validation.

## Verification

Run the composer voice tests, dictation hook tests, connector recording and
transcription-boundary tests, and native speech tests for changes to this flow.
Synthetic tests and component previews do not establish live microphone,
provider, or packaged-device acceptance.
