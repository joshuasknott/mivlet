import type { SVGProps } from "react";
import { builtinPluginEntries } from "../lib/builtin-plugins";

/** Existing licensed artwork lives in a cached SVG asset, outside JavaScript. */
const artwork: Record<string, SVGProps<SVGSVGElement>> = {
  github: {
    viewBox: "0 0 24 24",
    fill: "currentColor",
  },
  vercel: {
    viewBox: "0 0 24 24",
    fill: "currentColor",
  },
  "google-drive": {
    viewBox: "0 0 87.3 78",
  },
  notion: {
    viewBox: "0 0 24 24",
    fill: "currentColor",
  },
  gmail: {
    viewBox: "52 42 88 66",
  },
  slack: {
    viewBox: "0 0 127 127",
  },
  "google-calendar": {
    viewBox: "0 0 200 200",
  },
  linear: {
    viewBox: "0 0 24 24",
    fill: "#5E6AD2",
  },
  folder: {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
};

export function ConnectorIcon({ id }: { id: string }) {
  const builtin = builtinPluginEntries.find((entry) => entry.id === id);
  if (builtin)
    return <img src={builtin.icon} className="connector-icon-svg" alt="" />;
  const key = Object.hasOwn(artwork, id) ? id : "folder";
  return (
    <svg {...artwork[key]} className="connector-icon-svg">
      <use href={`/brand/connector-artwork.svg#${key}`} />
    </svg>
  );
}
