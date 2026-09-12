import { TeammateWorkspace } from "./TeammateWorkspace";

/** Bounded shell coordinator; the workspace owns its local presentation state. */
export function DesktopShell() {
  return <TeammateWorkspace />;
}
