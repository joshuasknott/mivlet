const nativeReady = "mivlet:native-chat-ready";
const previewReady = "mivlet:preview-chat-ready";

/** Local, count-only measurements. No IDs, content, URLs or automatic export. */
export function markChatReady(native: boolean) {
  const name = native ? nativeReady : previewReady;
  if (
    typeof performance.mark === "function" &&
    !performance.getEntriesByName(name).length
  )
    performance.mark(name);
}

export function readRendererPerformance() {
  const elapsed = (name: string) => {
    const value = performance.getEntriesByName(name)[0]?.startTime;
    return value !== undefined && Number.isFinite(value)
      ? Math.round(value * 100) / 100
      : null;
  };
  const memory = (
    performance as Performance & { memory?: { usedJSHeapSize?: number } }
  ).memory?.usedJSHeapSize;
  return {
    nativeChatReadyMs: elapsed(nativeReady),
    previewChatReadyMs: elapsed(previewReady),
    tableCellCount: document.querySelectorAll("tbody td").length,
    codeBlockCount: document.querySelectorAll("pre code").length,
    usedJsHeapBytes:
      memory !== undefined && Number.isFinite(memory) ? memory : null,
  };
}
