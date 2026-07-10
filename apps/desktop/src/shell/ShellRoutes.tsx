import { lazy, Suspense } from "react";
import type { ShellRuntime } from "../hooks/useShellRuntime";

const KnowledgePage = lazy(() => import("../components/pages/KnowledgePage").then((m) => ({ default: m.KnowledgePage })));
const SchedulesPage = lazy(() => import("../components/pages/SchedulesPage").then((m) => ({ default: m.SchedulesPage })));
const ConnectorsPage = lazy(() => import("../components/pages/ConnectorsPage").then((m) => ({ default: m.ConnectorsPage })));
const DepartmentsPage = lazy(() => import("../components/pages/DepartmentsPage").then((m) => ({ default: m.DepartmentsPage })));

export function ShellPage({ runtime }: { runtime: ShellRuntime }) {
  switch (runtime.activePage) {
    case "Departments": return <DepartmentsPage />;
    case "Connectors": return <ConnectorsPage runtime={runtime} />;
    case "Knowledge": return <KnowledgePage runtime={runtime} />;
    case "Schedules": return <SchedulesPage runtime={runtime} />;
    default: return null;
  }
}
export function ShellPageBoundary({ runtime }: { runtime: ShellRuntime }) {
  return <div className="workspace-center workspace-center--page"><Suspense fallback={null}><ShellPage runtime={runtime} /></Suspense></div>;
}
