import { lazy, Suspense, type ComponentProps } from "react";

const UsageDashboard = lazy(() =>
  import("./UsageDashboard").then((module) => ({
    default: module.UsageDashboard,
  })),
);

/** Defer the complete usage destination from Settings and account controls. */
export function ProviderUsageDetails(
  props: ComponentProps<typeof UsageDashboard>,
) {
  return (
    <Suspense fallback={<p role="status">Loading usage…</p>}>
      <UsageDashboard {...props} />
    </Suspense>
  );
}
