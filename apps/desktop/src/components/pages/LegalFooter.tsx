import { useRef, useState } from "react";
import { LegalDocument, type LegalDocumentKind } from "./LegalDocument";
import "./legal.css";

export function LegalFooter() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<LegalDocumentKind>("terms");
  function open(document: LegalDocumentKind) {
    setKind(document);
    dialog.current?.showModal();
  }
  return (
    <>
      <footer className="mivlet-legal-footer">
        <span>Read our </span>
        <button type="button" onClick={() => open("terms")}>
          Terms of Service
        </button>
        <span> and </span>
        <button type="button" onClick={() => open("privacy")}>
          Privacy Policy
        </button>
      </footer>
      <dialog
        ref={dialog}
        className="mivlet-legal-dialog"
        aria-label={kind === "terms" ? "Terms of Service" : "Privacy Policy"}
      >
        <form method="dialog">
          <button className="mivlet-legal-close">Close</button>
        </form>
        <LegalDocument kind={kind} />
      </dialog>
    </>
  );
}
