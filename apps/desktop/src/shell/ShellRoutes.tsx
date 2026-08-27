import { lazy, Suspense } from "react";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { HostedSchedulesPageState } from "../components/HostedSchedulesPanel";

const KnowledgePage = lazy(() => import("../components/pages/KnowledgePage").then((m) => ({ default: m.KnowledgePage })));
const SchedulesPage = lazy(() => import("../components/pages/SchedulesPage").then((m) => ({ default: m.SchedulesPage })));
const ConnectorsPage = lazy(() => import("../components/pages/ConnectorsPage").then((m) => ({ default: m.ConnectorsPage })));

export function ShellPage({ runtime, hostedComputer }: { runtime: ShellRuntime; hostedComputer?: HostedSchedulesPageState }) {
  switch (runtime.activePage) {
    case "Connectors": return <ConnectorsPage runtime={runtime} />;
    case "Knowledge": return <KnowledgePage runtime={runtime} />;
    case "Schedules": return <SchedulesPage runtime={runtime} hostedComputer={hostedComputer} />;
    default: return null;
  }
}
export function ShellPageBoundary({ runtime, hostedComputer }: { runtime: ShellRuntime; hostedComputer?: HostedSchedulesPageState }) {
  return <div className="workspace-center workspace-center--page"><Suspense fallback={null}><ShellPage runtime={runtime} hostedComputer={hostedComputer} /></Suspense></div>;
}
