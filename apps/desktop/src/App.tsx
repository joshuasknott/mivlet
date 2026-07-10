import { FableQueryProvider } from "./lib/query-client";
import { DesktopShell } from "./shell/DesktopShell";

/** Public desktop entry point. Runtime behavior lives inside the bounded shell. */
export function App() {
  return (
    <FableQueryProvider>
      <DesktopShell />
    </FableQueryProvider>
  );
}
