import { useId, useRef, useState } from "react";
import type { BackendProvider } from "@mivlet/protocol";
import { activeDataScope } from "../../runtime/bridge";
import { SubscriptionUsage } from "./SubscriptionUsage";
import "./provider-usage.css";
import { UsageHistory } from "./UsageHistory";

type View = "cost" | "tokens" | "limits";
const views: { id: View; label: string }[] = [
  { id: "cost", label: "Cost" },
  { id: "tokens", label: "Tokens" },
  { id: "limits", label: "Limits" },
];

/** One usage destination. History is mounted only when deliberately opened. */
export function UsageDashboard({
  initialProviderId = "",
  initialView = "cost",
  providers,
  connectedProviderIds,
}: {
  initialProviderId?: string;
  initialView?: View;
  providers?: BackendProvider[];
  connectedProviderIds?: string[];
}) {
  const [view, setView] = useState<View>(initialView);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const owner = useRef(activeDataScope());
  if (owner.current !== activeDataScope())
    return (
      <p role="status">
        The account or workspace changed. Close and reopen Usage.
      </p>
    );
  return (
    <div className="usage-dashboard">
      <div className="usage-tabs" role="tablist" aria-label="Usage view">
        {views.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${id}-${item.id}`}
            aria-controls={`${id}-panel`}
            aria-selected={view === item.id}
            tabIndex={view === item.id ? 0 : -1}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            onClick={() => setView(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % views.length
                  : event.key === "ArrowLeft"
                    ? (index + views.length - 1) % views.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? views.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                setView(views[next].id);
                tabs.current[next]?.focus();
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}`}>
        {view === "limits" ? (
          <SubscriptionUsage
            providers={providers}
            connectedProviderIds={connectedProviderIds}
            onOpenBreakdowns={() => setView("cost")}
          />
        ) : (
          <UsageHistory metric={view} initialProviderId={initialProviderId} />
        )}
      </div>
    </div>
  );
}
