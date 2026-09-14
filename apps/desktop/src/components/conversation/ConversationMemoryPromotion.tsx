import { useId, useRef, useState } from "react";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export interface MemoryScopeOption {
  id: "thread" | "agent" | "project";
  label: string;
  description: string;
}

/**
 * Deliberate promotion of one conclusion into the baseline Memory interface.
 * The user chooses the exact text and narrow scope; nothing else in the
 * conversation is summarized or promoted.
 */
export function ConversationMemoryPromotion({
  chatTitle,
  defaultTitle = "",
  defaultValue = "",
  scopes,
  onSave,
  onClose,
}: {
  chatTitle: string;
  defaultTitle?: string;
  defaultValue?: string;
  scopes: MemoryScopeOption[];
  onSave: (input: {
    title: string;
    value: string;
    scopeId: MemoryScopeOption["id"];
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [value, setValue] = useState(defaultValue);
  const [scopeId, setScopeId] = useState<MemoryScopeOption["id"]>(scopes[0]?.id ?? "thread");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useModalFocusTrap({
    active: true,
    containerRef: panel,
    onClose: () => {
      if (!pending) onClose();
    },
  });
  const valid = Boolean(title.trim() && value.trim());
  return (
    <div className="side-chat-dialog-backdrop">
      <div
        className="side-chat-dialog conversation-memory-promotion"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header>
          <h2 id={headingId}>Save conclusion to Memory</h2>
          <button
            type="button"
            disabled={pending}
            aria-label="Close Memory promotion"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) {
              setError("Add a title and the conclusion before saving.");
              return;
            }
            setPending(true);
            setError("");
            void onSave({ title: title.trim(), value: value.trim(), scopeId })
              .then(onClose)
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not save this conclusion to Memory.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <p>
            Record one conclusion from “{chatTitle}”. Only you create durable
            Memory; this saves the text below and its provenance, not the
            conversation transcript.
          </p>
          <label>
            Title
            <input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Short name for this conclusion"
            />
          </label>
          <label>
            Conclusion
            <textarea
              value={value}
              maxLength={2_000}
              rows={6}
              onChange={(event) => setValue(event.target.value)}
              placeholder="What should future conversations in this scope remember?"
            />
          </label>
          <fieldset className="conversation-memory-promotion__scopes">
            <legend>Applies to</legend>
            {scopes.map((scope) => (
              <label key={scope.id}>
                <input
                  type="radio"
                  name="memory-scope"
                  value={scope.id}
                  checked={scopeId === scope.id}
                  onChange={() => setScopeId(scope.id)}
                />
                <span>
                  <strong>{scope.label}</strong>
                  <small>{scope.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="side-chat-notice" role="note">
            Promoted conclusions stay visible in Memory. You can correct,
            disable or forget them there at any time.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending || !valid}>
              {pending ? "Saving…" : "Save to Memory"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
