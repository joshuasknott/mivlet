import { useEffect, useRef, useState } from "react";
import { getActiveRuntimeDataScope } from "../../runtime-scope";
import { exportPortableTransfer, importPortableTransfer } from "../../runtime/domains/portable-transfer";

export function PortableTransferSettings({ mode }: { mode: "export" | "import" }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const transfer = async () => {
    if (pending.current) return;
    const scope = getActiveRuntimeDataScope();
    const current = () => mounted.current && getActiveRuntimeDataScope() === scope;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "export") {
        const receipt = await exportPortableTransfer();
        if (current()) setNotice(`Saved ${receipt.fileName}. Keep the file and its passphrase separate.`);
      } else {
        const report = await importPortableTransfer();
        if (current()) setNotice(`Imported ${report.threads} conversations and ${report.messages} messages. Mivlet will restart; reconnect your providers.`);
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "The transfer did not finish.");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };

  return <div className="settings-page__body portable-transfer">
    <p>{mode === "export"
      ? "Create an encrypted transfer of private conversations outside projects, agents and selected memory for another computer. Chat text can contain sensitive information."
      : "Import a transfer from your other computer before connecting a provider. Sign in to the same Mivlet account; this destination must be empty."}</p>
    <p>Project rooms, provider credentials, approvals, running work and local file contents are excluded. Choose the file and enter its passphrase in the native dialogs.</p>
    <button type="button" className="button button-secondary" disabled={busy} onClick={() => { void transfer(); }}>
      {busy ? "Complete the native dialogs…" : mode === "export" ? "Export portable history" : "Import portable history"}
    </button>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
