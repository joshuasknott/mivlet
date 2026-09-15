import { useEffect, useRef, useState } from "react";
import { connectorErrorMessage } from "../../lib/connector-errors";

/** Serializes setup actions for one mounted connection detail, without storing credentials. */
export function useConnectorOperation(initialBusy = false, onSettled?: () => void) {
  const [busy, setBusy] = useState(initialBusy);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    epoch.current++;
    return () => { epoch.current++; };
  }, []);

  const run = async (task: (isCurrent: () => boolean) => void | Promise<void>) => {
    if (pending.current) return;
    const generation = epoch.current;
    const isCurrent = () => generation === epoch.current;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setFailed(false);
    try { await task(isCurrent); }
    catch (error) {
      if (isCurrent()) { setNotice(connectorErrorMessage(error)); setFailed(true); }
    } finally {
      pending.current = false;
      onSettled?.();
      if (isCurrent()) setBusy(false);
    }
  };
  return { busy, notice, failed, setBusy, setNotice, setFailed, run };
}
