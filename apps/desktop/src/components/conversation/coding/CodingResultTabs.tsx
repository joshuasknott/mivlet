import { useId, useState, type ReactNode } from "react";
import "./coding-result.css";

/** A result may expose only the views that have real native content. */
export function CodingResultTabs({ preview, files, changes, terminal }: {
  preview?: ReactNode; files?: ReactNode; changes?: ReactNode; terminal?: ReactNode;
}) {
  const id = useId();
  const [selected, setSelected] = useState("Preview");
  const tabs = [{ label: "Preview", content: preview }, { label: "Files", content: files }, { label: "Changes", content: changes }].filter((tab) => tab.content !== undefined && tab.content !== null && tab.content !== false);
  const current = tabs.find((tab) => tab.label === selected) ?? tabs[0];
  if (!current && !terminal) return null;
  return <section className="coding-result" aria-label="Coding result">
    {current && <div className="coding-result__views">
      <div className="coding-result__tabs" role="tablist" aria-label="Result views">{tabs.map((tab, index) => <button key={tab.label} type="button" role="tab" id={`${id}-${tab.label}`} aria-controls={`${id}-panel`} aria-selected={current.label === tab.label} tabIndex={current.label === tab.label ? 0 : -1} onClick={() => setSelected(tab.label)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setSelected(tabs[next].label);
        document.getElementById(`${id}-${tabs[next].label}`)?.focus();
      }}>{tab.label}</button>)}</div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${current.label}`}>{current.content}</div>
    </div>}
    {terminal}
  </section>;
}
