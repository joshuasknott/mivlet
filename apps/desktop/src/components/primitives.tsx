/**
 * Small presentational primitives shared across the workspace shell.
 * Extracted verbatim from App.tsx so panels can reuse them.
 */

export function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}
