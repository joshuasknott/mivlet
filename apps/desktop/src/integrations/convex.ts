import { ConvexReactClient } from "convex/react";

export function createOptionalConvexClient() {
  const url = import.meta.env.VITE_CONVEX_URL;
  return url ? new ConvexReactClient(url) : null;
}
