import { useEffect, useRef, useState } from "react";
import type { NativeCommandFrame, NativeCommandInput, NativeCommandInputReceipt, NativeCommandJob, NativeCommandTarget } from "@mivlet/protocol";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { readNativeCommandOutput, stopNativeCommandJob, writeNativeCommandInput } from "../../../runtime/domains/command-jobs";
import "./coding-result.css";

export interface CodingTerminalProps {
  target: NativeCommandTarget;
  job: NativeCommandJob;
  writeInput?: (request: NativeCommandInput) => Promise<NativeCommandInputReceipt | null>;
  onJobChange?: (job: NativeCommandJob) => void;
}
const live = (job: NativeCommandJob) => ["preparing", "running", "stopping"].includes(job.status);
const labels: Record<NativeCommandJob["status"], string> = {
  preparing: "Preparing", running: "Running", stopping: "Stopping", succeeded: "Finished",
  failed: "Failed", stopped: "Stopped", "timed-out": "Timed out", interrupted: "Interrupted",
};
const message = (error: unknown) => error instanceof Error ? error.message : "The terminal is unavailable.";
function boundedTerminalWait<T>(request: Promise<T>, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([request, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), 10_000);
  })]).finally(() => clearTimeout(timer));
}

export function appendTerminalFrames(previous: NativeCommandFrame[], incoming: NativeCommandFrame[]) {
  const known = new Set(previous.map((frame) => frame.sequence));
  const lastSequence = previous.at(-1)?.sequence ?? -1;
  const frames = [...previous, ...incoming.filter((frame) => {
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= lastSequence || known.has(frame.sequence)) return false;
    known.add(frame.sequence); return true;
  })]
    .sort((a, b) => a.sequence - b.sequence);
  let bytes = frames.reduce((size, frame) => size + new TextEncoder().encode(frame.text).byteLength, 0);
  let dropped = false;
  while (frames.length && (frames.length > 512 || bytes > 65_536)) {
    bytes -= new TextEncoder().encode(frames.shift()!.text).byteLength;
    dropped = true;
  }
  return { frames, dropped };
}

/** Changing any native owner fence discards output, pending input and cursors. */
export function CodingTerminal(props: CodingTerminalProps) {
  if (props.job.id !== props.target.jobId || props.job.generation !== props.target.jobGeneration)
    return <p role="alert">This terminal no longer belongs to the selected result. Open the current session.</p>;
  return <TerminalSession key={JSON.stringify(props.target)} {...props} />;
}
function TerminalSession({ target: suppliedTarget, job: initialJob, writeInput = writeNativeCommandInput, onJobChange }: CodingTerminalProps) {
  const [target] = useState(suppliedTarget);
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState(initialJob);
  const [frames, setFrames] = useState<NativeCommandFrame[]>([]);
  const [connection, setConnection] = useState<"idle" | "reading" | "connected" | "closed" | "unavailable">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inputNotice, setInputNotice] = useState("");
  const [redacted, setRedacted] = useState(false);
  const [retry, setRetry] = useState(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cursor = useRef(0);
  const retained = useRef<NativeCommandFrame[]>([]);
  const inputSequenceFence = useRef(initialJob.inputSequence ?? 0);
  const uncertainAttempt = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const onChange = useRef(onJobChange);
  onChange.current = onJobChange;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    inputSequenceFence.current = Math.max(inputSequenceFence.current, initialJob.inputSequence ?? 0);
    setJob({ ...initialJob, inputSequence: inputSequenceFence.current });
  }, [initialJob]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Captured only when the user explicitly opens/reconnects output. Ordinary
    // polling cannot silently unlock input after an uncertain write.
    const reconcileInput = uncertainAttempt.current;
    setConnection("reading");
    const poll = async () => {
      try {
        const result = await Promise.race([
          readNativeCommandOutput(target, cursor.current),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Output did not respond. Reconnect to check the existing session.")), 10_000); }),
        ]).finally(() => clearTimeout(timeout));
        if (disposed) return;
        if (!result) throw new Error("Open Mivlet desktop to reconnect this terminal.");
        if (result.job.id !== target.jobId || result.job.generation !== target.jobGeneration)
          throw new Error("The terminal identity changed. Open the current result again.");
        inputSequenceFence.current = Math.max(inputSequenceFence.current, result.job.inputSequence ?? 0);
        setJob({ ...result.job, inputSequence: inputSequenceFence.current });
        onChange.current?.(result.job);
        setError("");
        if (reconcileInput !== undefined && uncertainAttempt.current === reconcileInput) {
          if (!live(result.job)) {
            setInputNotice("This session has ended. The uncertain line was not resent.");
          } else if (result.job.status === "running" && (result.job.inputSequence ?? 0) >= reconcileInput) {
            uncertainAttempt.current = undefined;
            setUncertain(false);
            setInputNotice("The saved input sequence was checked. The earlier line was not resent; you can send a new line.");
          }
        }
        if (result.outputUnavailable || !result.output) {
          setConnection("unavailable");
          setNotice("Output is no longer retained. The command has not been restarted.");
          return;
        }
        if (!Number.isSafeInteger(result.output.nextCursor) || result.output.nextCursor < cursor.current)
          throw new Error("The output cursor changed. Reopen the current session.");
        cursor.current = result.output.nextCursor;
        const output = result.output;
        const next = appendTerminalFrames(retained.current, output.frames);
        retained.current = next.frames;
        setFrames(next.frames);
        if (next.dropped) setNotice("Older output exceeded the retained history limit.");
        if (output.dropped) setNotice("Some earlier output is no longer retained.");
        setRedacted((previous) => previous || output.redacted);
        setConnection(output.closed ? "closed" : "connected");
        if (!output.closed) timer = setTimeout(() => void poll(), 500);
      } catch (failure) {
        if (!disposed) { setConnection("unavailable"); setError(message(failure)); }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(timeout); };
  }, [open, retry, target]);
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      const result = await boundedTerminalWait(stopNativeCommandJob(target), "Stop confirmation did not arrive. Reconnect output to check the existing session.");
      if (!mounted.current) return;
      if (!result || result.job.id !== target.jobId || result.job.generation !== target.jobGeneration)
        throw new Error("The terminal could not confirm Stop. Reconnect to check its status.");
      setJob(result.job); onChange.current?.(result.job); setError("");
      setRetry((value) => value + 1);
    } catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { if (mounted.current) setStopping(false); }
  }
  async function send() {
    if (!writeInput || sending || uncertain || !input || !job.interactive || job.status !== "running") return;
    const text = `${input}\n`;
    if (new TextEncoder().encode(text).byteLength > 4096) { setError("Keep terminal input within 4 KiB."); return; }
    const inputSequence = inputSequenceFence.current + 1;
    inputSequenceFence.current = inputSequence;
    setSending(true); setInput(""); setError("");
    try {
      const receipt = await boundedTerminalWait(writeInput({ ...target, inputSequence, text }), "Input delivery is uncertain.");
      if (!mounted.current) return;
      if (!receipt || receipt.jobId !== target.jobId || receipt.jobGeneration !== target.jobGeneration || receipt.inputSequence !== inputSequence || receipt.delivery !== "accepted") {
        uncertainAttempt.current = inputSequence; setUncertain(true);
        setInputNotice("Input delivery was not confirmed. It will not be resent. Reconnect to check whether the session stopped or consumed the line.");
      } else {
        setJob((current) => ({ ...current, inputSequence }));
        setInputNotice("Input delivered to the process. Read output to check its result.");
      }
    } catch {
      if (mounted.current) { uncertainAttempt.current = inputSequence; setUncertain(true); setInputNotice("Input delivery was not confirmed. It will not be resent. Reconnect to check whether the session stopped or consumed the line."); }
    } finally { if (mounted.current) setSending(false); }
  }
  return <details className="coding-terminal" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span><TerminalWindow size={16} aria-hidden="true" /> Terminal</span><span className="coding-result__status">{labels[job.status]}</span></summary>
    {open && <div className="coding-terminal__body">
      <div className="coding-result__toolbar"><span role="status">{connection === "connected" ? "Output connected" : connection === "reading" ? "Reading output…" : connection === "closed" ? "Output closed" : connection === "unavailable" ? "Output disconnected" : "Output not connected"}{job.exitCode !== null ? ` · Exit ${job.exitCode}` : ""}</span><div><button type="button" onClick={() => { setError(""); setRetry((value) => value + 1); }}>Reconnect output</button>{live(job) && <button type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop"}</button>}</div></div>
      {error && <p role="alert">{error}</p>}
      <pre tabIndex={0} aria-label="Terminal output">{frames.length ? frames.map((frame) => frame.text).join("") : connection === "unavailable" ? "Output unavailable." : "No output yet."}</pre>
      {notice && <p className="coding-result__notice" role="status">{notice}</p>}
      {inputNotice && <p className="coding-result__notice" role="status">{inputNotice}</p>}
      {redacted && <p className="coding-result__notice">Some output was redacted or omitted.</p>}
      {job.interactive && <form className="coding-terminal__input" onSubmit={(event) => { event.preventDefault(); void send(); }}><label className="coding-result__sr-only" htmlFor={`terminal-input-${job.id}`}>Terminal input</label><input id={`terminal-input-${job.id}`} value={input} autoComplete="off" spellCheck={false} maxLength={4095} disabled={sending || uncertain || job.status !== "running" || !writeInput} onChange={(event) => setInput(event.target.value)} placeholder="Send a line…" /><button type="submit" disabled={sending || uncertain || !input || job.status !== "running" || !writeInput}>{sending ? "Sending…" : "Send line"}</button></form>}
    </div>}
  </details>;
}
