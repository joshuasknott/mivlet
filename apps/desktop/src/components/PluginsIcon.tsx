/** A rounded two-pin plug, shared by navigation and the composer. */
export function PluginsIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <g transform="rotate(45 12 12)">
      <path d="M9 3v5m6-5v5M6.5 8h11M8 8v5a4 4 0 0 0 8 0V8m-4 9v4" />
    </g>
  </svg>;
}
