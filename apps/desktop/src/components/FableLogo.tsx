export function FableLogo({
  className = "",
  size = "default"
}: {
  className?: string;
  size?: "default" | "hero";
}) {
  const markModifier = size === "hero" ? " brand-mark--hero" : "";
  return (
    <span
      className={`brand-lockup${className ? ` ${className}` : ""}`}
      title="Fable"
      aria-hidden="true"
    >
      <img
        className={`brand-mark${markModifier}`}
        src="/brand/fable-dragon-ember.png"
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
