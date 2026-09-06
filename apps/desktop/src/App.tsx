import { WindowControls } from "./components/WindowControls";
import { FableQueryProvider } from "./lib/query-client";
import { DesktopShell } from "./shell/DesktopShell";

/** Public desktop entry point. Runtime behavior lives inside the bounded shell. */
export function App() {
  return (
    <FableQueryProvider>
      <WindowControls />
      <DesktopShell />
    </FableQueryProvider>
  );
}
