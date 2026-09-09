/** Product identity only. Agent portraits retain their independent identity. */
export function Brand({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  const asset = compact ? "symbol" : "lockup";
  return (
    <span
      className={`mivlet-brand ${compact ? "mivlet-brand--compact" : ""} ${className}`}
      role="img"
      aria-label="Mivlet"
    >
      <img
        className="mivlet-brand__light"
        src={`/brand/mivlet-${asset}-light.png`}
        alt=""
        aria-hidden="true"
      />
      <img
        className="mivlet-brand__dark"
        src={`/brand/mivlet-${asset}-dark.png`}
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
