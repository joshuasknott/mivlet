import { useState } from "react";
import { Minus } from "@phosphor-icons/react/dist/csr/Minus";
import { Square } from "@phosphor-icons/react/dist/csr/Square";
import { X } from "@phosphor-icons/react/dist/csr/X";
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
    <div id="window-tabs" className="window-controls__tabs" />
    <div className="window-controls__drag" aria-hidden="true" onMouseDown={(event) => { if (event.button === 0 && event.detail === 1) act("drag"); }} onDoubleClick={() => act("maximize")} />
    {([{ action: "minimize", label: "Minimize window", Icon: Minus }, { action: "maximize", label: "Maximize or restore window", Icon: Square }, { action: "close", label: "Close window", Icon: X }]).map(({ action, label, Icon }) => <button key={action} type="button" className={`window-controls__${action}`} aria-label={label} title={label} onClick={() => act(action)}><Icon size={13} aria-hidden="true" /></button>)}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
