import { useRef } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export function PrivacySummary() {
  return (
    <dl className="privacy-summary">
      <div>
        <dt>On this device</dt>
        <dd>
          Your conversations, agents, and workspace data are saved locally.
          API keys and connection tokens are held by the desktop credential
          store.
        </dd>
      </div>
      <div>
        <dt>Your Fable account</dt>
        <dd>
          Clerk handles account sign-in. Signing in does not upload your local
          conversations.
        </dd>
      </div>
      <div>
        <dt>Model providers</dt>
        <dd>
          Your messages and the context used for a response are sent to the
          provider you select. That provider handles its own data retention and
          billing.
        </dd>
      </div>
      <div>
        <dt>Connected apps</dt>
        <dd>
          Fable requests the permissions shown during connection. You can review
          and disconnect each app in Plugins.
        </dd>
      </div>
    </dl>
  );
}

export function PrivacyNotice({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModalFocusTrap({ active: true, containerRef: ref, onClose });
  return (
    <div className="settings-modal-backdrop">
      <section
        ref={ref}
        className="account-dialog privacy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-notice-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="settings-modal__close"
          aria-label="Close privacy information"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <h2 id="privacy-notice-title">Privacy &amp; data</h2>
        <p>How Fable handles your information.</p>
        <PrivacySummary />
      </section>
    </div>
  );
}
