import type { useLocalComputer } from "../../hooks/useLocalComputer";

export function NativeComputerPanel({ agentName, computer }: { agentName: string; computer: ReturnType<typeof useLocalComputer> }) {
  const control = computer.node?.control;
  const controlling = control?.status === "active" || control?.status === "connecting" || control?.status === "busy";
  return <section className="native-computer-panel" aria-label="Windows application control">
    <header><div><strong>This PC</strong><small>Windows applications</small></div>
      {controlling ? <button type="button" className="native-computer-stop" onClick={() => void computer.stop().catch(() => undefined)}>Stop</button> : null}
    </header>
    {computer.loading ? <p role="status">Checking Computer Use…</p>
      : !computer.node ? <p>Computer status is unavailable. Refresh it to check whether {agentName} can use this PC.</p>
      : !computer.node.plugins ? <p>Computer capability information is unavailable. Restart the desktop app to load its current runtime.</p>
      : !computer.node.plugins.computer ? <p>Enable Computer Use in Plugins to let {agentName} use an application.</p>
      : !computer.node.runtimeAvailable ? <p>Computer Use is enabled, but application control is unavailable. Workspace files remain available below.</p>
      : control?.status === "active" ? <div role="status"><strong>{control.application}</strong><p>{control.deliveryMode === "background" ? `${agentName} is using supported controls in the background. Using that app stops control.` : `${agentName} is using the foreground window.`} Stop anytime with Ctrl+Alt+Esc.</p></div>
      : control?.status === "connecting" ? <p role="status">Connecting to {control.application}…</p>
      : control?.status === "busy" ? <p role="status">Another agent is using this PC. Stop its control before starting here.</p>
      : <p>Tell {agentName} what to do. It will use supported app controls in the background. Bringing an app forward follows your approval settings.</p>}
    {control?.message && control.status === "idle" ? <small role="status">{control.message}</small> : null}
    {computer.error ? <p role="alert">{computer.error}</p> : null}
    {!controlling ? <button type="button" disabled={computer.loading} onClick={() => void computer.refresh().catch(() => undefined)}>Refresh computer status</button> : null}
    {computer.node?.retiredComputer ? <details className="native-computer-retired"><summary>Previous computer files</summary><p>Your previous Linux computer is retired. Files shared with Mivlet remain in Files below. Its Docker home volume is preserved; files saved only there need manual export using Docker. No volumes were deleted.</p></details> : null}
  </section>;
}
