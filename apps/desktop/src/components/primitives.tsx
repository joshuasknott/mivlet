import { ReactNode } from "react";

/**
 * Small presentational primitives shared across the workspace shell.
 * Extracted verbatim from App.tsx so panels can reuse them.
 */

export function ShellButton({
  children,
  pressed,
  onClick,
  label
}: {
  children: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      className="shell-button"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function StatusDot({ tone }: { tone: "ready" | "needs-auth" | "draft" | "paused" }) {
  return <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />;
}

export function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}
