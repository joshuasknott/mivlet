import { useState } from "react";
import { getRuntimeAdapter, hasNativeRuntimeAdapter } from "../runtime/adapters/select";

export function WindowControls({ preview = false }: { preview?: boolean }) {
  const [error, setError] = useState("");
  if (!preview && !hasNativeRuntimeAdapter()) return null;
  const act = (action: string) => {
    if (preview) return;
    setError("");
    void getRuntimeAdapter().invoke("control_main_window", { action }).catch(() => setError("Window control failed. Try again."));
  };
  return <div className="window-controls">
    <div className="window-controls__drag" aria-hidden="true" onMouseDown={(event) => { if (event.button === 0 && event.detail === 1) act("drag"); }} onDoubleClick={() => act("maximize")} />
    {[["minimize", "Minimize window", "−"], ["maximize", "Maximize or restore window", "□"], ["close", "Close window", "×"]].map(([action, label, icon]) => <button key={action} type="button" className={`window-controls__${action}`} aria-label={label} title={label} onClick={() => act(action)}><span aria-hidden="true">{icon}</span></button>)}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
