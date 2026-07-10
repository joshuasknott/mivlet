import { ChatWorkspace } from "./ChatWorkspace";

/** Bounded shell coordinator; the workspace owns its local presentation state. */
export function DesktopShell() {
  return <ChatWorkspace />;
}
