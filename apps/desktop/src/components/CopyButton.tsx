import { CopySimple } from "@phosphor-icons/react/dist/csr/CopySimple";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { useEffect, useState } from "react";

/** Copies only the text the user selected; never reads the clipboard. */
export function CopyButton({ text, label = "Copy", iconOnly = false }: { text: string; label?: string; iconOnly?: boolean }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <span className="copy-control">
    <button type="button" aria-label={label} title={status === "copied" ? "Copied" : label} onClick={() => {
      if (!navigator.clipboard?.writeText) { setStatus("failed"); return; }
      void navigator.clipboard.writeText(text).then(() => setStatus("copied"), () => setStatus("failed"));
    }}>{iconOnly ? status === "copied" ? <Check size={17} weight="bold" aria-hidden="true" /> : <CopySimple size={17} weight="regular" aria-hidden="true" /> : status === "copied" ? "Copied" : label}</button>
    {status === "copied" ? <span className="sr-only" role="status">Copied to clipboard.</span> : null}
    {status === "failed" ? <small role="status">Copy unavailable. Select the text and press Ctrl+C.</small> : null}
  </span>;
}
