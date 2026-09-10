import type { ConversationContextFailure } from "../../lib/conversation-context";

export function ContextRecoveryPanel({
  failure,
  disabled,
  onPrepareHandoff,
}: {
  failure: ConversationContextFailure;
  disabled?: boolean;
  onPrepareHandoff: () => void;
}) {
  return <div className="conversation-attention" role="alert">
    <p>{failure.message}</p>
    <details>
      <summary>Context budget details</summary>
      <small>
        Local input estimate: {failure.estimatedInputTokens.toLocaleString()} tokens ({failure.tokenizer}). Provider tokenization may differ. Output reserve: {failure.outputReserveTokens.toLocaleString()} tokens.
        {failure.contextWindowTokens ? ` Provider capacity: ${failure.contextWindowTokens.toLocaleString()} tokens; Mivlet uses up to ${failure.usableContextTokens?.toLocaleString()} before the safety reserve.` : " The provider did not report a model capacity, so Mivlet did not guess one."}
        {failure.nativeHistoryMaxUtf8Bytes ? ` Native Codex history: ${failure.historyUtf8Bytes.toLocaleString()} / ${failure.nativeHistoryMaxUtf8Bytes.toLocaleString()} UTF-8 bytes.` : ""}
      </small>
    </details>
    {failure.reason !== "invalid-output-budget" ? <button type="button" disabled={disabled} onClick={onPrepareHandoff}>Review continuation</button> : null}
    <small>The handoff opens as an editable draft in a new conversation. It does not carry approvals or current computer state.</small>
  </div>;
}
