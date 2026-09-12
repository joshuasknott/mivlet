import { useEffect, useState } from "react";

/** Copies only the text the user selected; never reads the clipboard. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <span className="copy-control">
    <button type="button" aria-label={label} onClick={() => {
      if (!navigator.clipboard?.writeText) { setStatus("failed"); return; }
      void navigator.clipboard.writeText(text).then(() => setStatus("copied"), () => setStatus("failed"));
    }}>{status === "copied" ? "Copied" : label}</button>
    {status === "copied" ? <span className="sr-only" role="status">Copied to clipboard.</span> : null}
    {status === "failed" ? <small role="status">Copy unavailable. Select the text and press Ctrl+C.</small> : null}
  </span>;
}
