# Voice conversations

Voice is an input/output layer around Mivlet's existing named agent. The user's
selected provider, conversation context, tools, one-use approvals, execution
journal, and Stop path remain the authority for agent work. Dictation remains a
separate way to edit a draft; starting a call preserves that draft and does not
silently submit its attachments.

## Request flow

1. The waveform button opens the voice view. Start voice explicitly authorizes
   automatic transcription and AI-generated speech for this call, using the
   user's separately connected, metered OpenAI API account.
2. A bundled AudioWorklet captures mono microphone frames. Local turn detection
   keeps 350 ms of pre-roll, recognizes speech onset, and ends a turn after
   approximately 900 ms of silence or one minute. Echo cancellation, noise
   suppression and automatic gain control are requested from the device.
3. Native Rust validates a bounded 24 kHz PCM WAV request and transcribes it
   with `gpt-4o-mini-transcribe`. Neither the key nor network egress enters the
   renderer. The transcript automatically enters the ordinary agent execution
   path and encrypted conversation history.
4. Only assistant text deltas that have reached the durable checkpoint feed
   the speech queue. Complete sentences use `gpt-4o-mini-tts` and a chosen built-in
   voice. WAV playback begins sentence by sentence, including while the agent
   is still generating. Reasoning events never feed speech. Markdown formatting,
   code and URL destinations are omitted from speech; full text stays in chat.
   One additional sentence is prepared ahead of playback to reduce gaps without
   creating an unbounded queue of paid requests.
5. New speech immediately interrupts playback and invalidates that voice turn.
   The native speech generation changes, and the existing agent Stop path
   revokes pending approvals and computer work. The next transcript waits for
   the previous agent turn to settle, preventing overlapping execution.

Microphone interruption is enabled only when the device confirms echo
cancellation. Otherwise the microphone pauses during playback and the user uses
Interrupt. Mute disables the track and discards unfinished input. Pending tool
approvals also pause microphone input and show the existing approval controls
inside the call. Speech cannot approve those actions.

## Call authority and limits

One native call may exist at a time. Its random session capability is bound to
the installation owner, workspace, agent, thread and expiry. Native speech
requests also bind a monotonic turn generation and unique single-use request
ID. Failed requests are consumed, stale generations are refused, and End or a
replacement call revokes the old session. In-flight HTTP requests monitor
revocation every 100 ms and drop the connection on revocation. A renderer
heartbeat every 10 seconds maintains a 45-second lease; a renderer crash cannot
leave indefinite native speech authority.

- 30 minutes per call; the UI also ends after 3 minutes waiting for input.
- 60 seconds per utterance, with native format/length validation.
- 10 minutes of captured audio and 24,000 synthesized characters per call.
- 512 unique requests and at most 3 in flight, with bounded response bodies
  and 45-second HTTP timeouts.
- Replies longer than approximately 6,000 spoken characters direct the user to
  the remainder in chat. Voice instructions request short conversational replies.

These limits bound traffic; they are not a quoted price or a currency budget.
No raw input/output audio is written to disk, conversation records or logs by
Mivlet. OpenAI's processing policies apply to the audio and speech text it receives.
Credentials remain in native secure storage. Production CSP adds only local
`blob:` media playback; provider network access remains unavailable to React.

## Verification

Focused controller tests cover automatic turns, early speech, cancellation,
late-result fences, mute, approval pauses, missing echo cancellation, connection
cleanup and expiry. Audio tests cover silence/click rejection, pre-roll,
discarding input, PCM bounds and speech text shaping. Native tests cover scope,
owner, lease, replay, generation, concurrency, quotas and format validation.

`design-preview.html?view=voice` is a labelled preview of the production view at
different sizes and states. It does not use a microphone or a provider.

Live acceptance still requires the packaged Windows app with a connected agent
and OpenAI API account: actual device permissions, ambient noise, speaker echo,
headset interruption, latency, provider failure/reconnect, tool approval and
Stop. Fixtures and local test passes do not establish that live acceptance.

API reference: [OpenAI speech generation](https://developers.openai.com/api/docs/guides/text-to-speech)
and [AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode).

## Pending shell integration

This implementation currently enters agent execution through `ChatWorkspace`
and `useNativeAgent`. PR #49 replaces that shell with `ConversationPane` and
`ExecutionWorker`. Its integration must explicitly carry over the call entry,
scope/route fences, untouched drafts, durable text callback, approval pause and
abort/Stop bridge. The speech controller, native authority and call view can be
reused, but a successful check of this checkout does not verify that replacement
shell. Keep that adaptation as a deliberate integration step when PR #49 lands.
