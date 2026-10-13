import type { Dispatch, SetStateAction } from "react";
import { appendResponseText } from "../../lib/conversation-presentation";
import type { NativeAgentState } from "./types";

/** Coalesce screen text only. Canonical writes and lifecycle events stay immediate. */
export function createTextPresentation(
  setState: Dispatch<SetStateAction<NativeAgentState>>,
  attemptId: string,
  threadId: string | undefined,
  isScopeCurrent: () => boolean,
) {
  let chunks: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!chunks.length) return;
    const text = chunks.join("");
    chunks = [];
    if (!isScopeCurrent()) return;
    setState((current) =>
      isScopeCurrent() && current.currentAttemptId === attemptId && current.progressThreadId === threadId
        ? {
            ...current,
            transcript: current.transcript + text,
            responseParts: appendResponseText(current.responseParts ?? [], text),
            activity: "",
          }
        : current,
    );
  };
  return {
    flush,
    append(text: string) {
      if (!text) return;
      chunks.push(text);
      // A timer also publishes a lone delta while the provider is awaiting input.
      if (timer === undefined) timer = setTimeout(flush, 32);
    },
  };
}
