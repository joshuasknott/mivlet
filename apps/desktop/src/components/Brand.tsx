/** Product identity only. Agent portraits retain their independent identity. */
export function Brand({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`mivlet-brand ${compact ? "mivlet-brand--compact" : ""} ${className}`}
      role="img"
      aria-label="Mivlet"
    />
  );
}
