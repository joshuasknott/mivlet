(() => {
  "use strict";
  const binding = __MIVLET_NATIVE_PREVIEW_BINDING__;
  let enabled = false;
  const outline = document.createElement("div");
  outline.setAttribute("aria-hidden", "true");
  Object.assign(outline.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483647", border: "2px solid #6d5dfc", borderRadius: "4px", display: "none" });
  function publicElement(node) {
    return node instanceof HTMLElement && node !== outline &&
      !node.closest("input,textarea,select,[contenteditable],[data-mivlet-private]") &&
      !node.querySelector("input,textarea,select,[contenteditable],[data-mivlet-private]");
  }
  function send(kind, extra = {}) {
    parent.postMessage({ kind, ...binding, ...extra }, "*");
  }
  addEventListener("message", event => {
    const data = event.data;
    if (event.source !== parent || !data || data.kind !== "mivlet-preview-pick-mode" ||
        data.previewId !== binding.previewId || data.jobId !== binding.jobId ||
        data.jobGeneration !== binding.jobGeneration || data.revision !== binding.revision || typeof data.enabled !== "boolean") return;
    enabled = data.enabled;
    if (!enabled) outline.style.display = "none";
  });
  document.addEventListener("pointermove", event => {
    if (!enabled || !publicElement(event.target)) { outline.style.display = "none"; return; }
    if (!outline.isConnected) document.documentElement.append(outline);
    const rect = event.target.getBoundingClientRect();
    Object.assign(outline.style, { display: "block", left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }, true);
  document.addEventListener("click", event => {
    if (!enabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.isTrusted || !publicElement(event.target)) return;
    const element = event.target;
    const rect = element.getBoundingClientRect();
    const label = (element.getAttribute("aria-label") || element.innerText || element.tagName).replace(/\s+/g, " ").trim().slice(0, 200);
    if (!label || rect.width <= 0 || rect.height <= 0) return;
    enabled = false; outline.style.display = "none";
    send("mivlet-preview-pick", { path: location.pathname, tag: element.tagName, label, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }, true);
  send("mivlet-preview-ready");
})();
