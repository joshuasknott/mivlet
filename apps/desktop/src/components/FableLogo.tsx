export function FableLogo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`brand-lockup${className ? ` ${className}` : ""}`}
      title="Fable"
      aria-hidden="true"
    >
      <img className="brand-mark" src="/brand/fable-mark.svg" alt="" aria-hidden="true" />
    </span>
  );
}
