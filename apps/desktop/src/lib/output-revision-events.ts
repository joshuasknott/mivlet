import type { OfficeCellSelection } from "../components/conversation/OfficePreview";
import type { OutputRevisionRequest } from "./output-revisions";

export type OutputRevisionEvent =
  | { kind: "selection"; conversationId: string; intent: "quote" | "explain" | "memory"; selection: string; reference: string; handled: boolean; resolve: () => void; reject: (error: Error) => void }
  | { kind: "text"; conversationId: string; request: OutputRevisionRequest; handled?: boolean }
  | { kind: "office"; conversationId: string; selection: OfficeCellSelection; handled?: boolean };

export type OutputRevisionAppliedEvent = {
  outputId: string;
  conversationId: string;
  output: import("./output-revisions").OutputDocument;
};

export type OutputPinnedEvent = {
  workspaceId: string;
  output: import("./output-revisions").OutputDocument;
};

const EVENT = "mivlet-output-revision-request";
const APPLIED_EVENT = "mivlet-output-revision-applied";
const PINNED_EVENT = "mivlet-output-pinned";

export function requestOutputSelection(conversationId: string, intent: "quote" | "explain" | "memory", selection: string, reference: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const event: OutputRevisionEvent = { kind: "selection", conversationId, intent, selection, reference, handled: false, resolve, reject };
    emitOutputRevisionRequest(event);
    if (!event.handled) reject(new Error("Open the originating conversation beside this output to use this action."));
  });
}

export function emitOutputRevisionRequest(detail: OutputRevisionEvent) {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent<OutputRevisionEvent>(EVENT, { detail }),
    );
  return detail.handled === true;
}

export function subscribeOutputRevisionRequests(
  listener: (event: OutputRevisionEvent) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OutputRevisionEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

export function emitOutputRevisionApplied(detail: OutputRevisionAppliedEvent) {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent<OutputRevisionAppliedEvent>(APPLIED_EVENT, { detail }),
    );
}

export function subscribeOutputRevisionApplied(
  listener: (event: OutputRevisionAppliedEvent) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OutputRevisionAppliedEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(APPLIED_EVENT, handler);
  return () => window.removeEventListener(APPLIED_EVENT, handler);
}

/** Notify library surfaces after the native pin state has been durably changed. */
export function emitOutputPinned(detail: OutputPinnedEvent) {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent<OutputPinnedEvent>(PINNED_EVENT, { detail }));
}

export function subscribeOutputPinned(
  listener: (event: OutputPinnedEvent) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OutputPinnedEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(PINNED_EVENT, handler);
  return () => window.removeEventListener(PINNED_EVENT, handler);
}
