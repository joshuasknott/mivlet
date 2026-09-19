import { WindowControls } from "./components/WindowControls";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import { MivletQueryProvider } from "./lib/query-client";
import { DesktopShell } from "./shell/DesktopShell";

/** Public desktop entry point. Runtime behavior lives inside the bounded shell. */
export function App() {
  return (
    <MivletQueryProvider>
      <WindowControls />
      <WorkspaceErrorBoundary>
        <DesktopShell />
      </WorkspaceErrorBoundary>
    </MivletQueryProvider>
  );
}
