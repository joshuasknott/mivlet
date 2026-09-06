import { createRfb } from "./viewer/fable-rfb.js";

const screen = document.querySelector("#screen");
const status = document.querySelector("#status");
const controlState = document.querySelector("#control-state");
const privacy = document.querySelector("#privacy");
const take = document.querySelector("#take");
const resume = document.querySelector("#resume");
const reconnect = document.querySelector("#reconnect");
let generation = 0;
let controller = "paused";
let rfb;
let connecting = false;
let transitioning = false;
let stopped = false;
let queue = Promise.resolve();
let connectionEpoch = 0;
let pointerDown = false;
let lastMove = 0;

async function request(path, body) {
  const response = await fetch(new URL(path, location.href), body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (!response.ok) throw new Error("The computer needs to reconnect. Input has stopped.");
  return response.status === 204 ? null : response.json();
}

function updateControls() {
  take.disabled = transitioning || !generation;
  take.hidden = controller === "human";
  resume.disabled = transitioning || !generation;
  resume.hidden = controller === "agent";
  resume.textContent = controller === "paused" ? "Let agent continue" : "Return control";
  controlState.textContent = transitioning ? "Pausing current work…" : controller === "human" ? "You have control" : controller === "paused" ? "Paused" : "Watching";
  privacy.textContent = controller === "human" ? "Agent observation and actions are paused. F6 opens viewer controls. Closing keeps the agent paused."
    : controller === "paused" ? "The agent cannot observe or act. Choose who continues."
    : "Watching the agent. Take control for a private step.";
}

async function connect() {
  if (connecting || !generation || stopped) return;
  connecting = true;
  const epoch = ++connectionEpoch;
  const expected = generation;
  rfb?.disconnect();
  rfb = undefined;
  screen.replaceChildren();
  status.textContent = "Connecting to the computer…";
  reconnect.style.display = "none";
  try {
    const url = new URL("./websockify", location.href);
    url.protocol = "ws:";
    url.searchParams.set("generation", String(expected));
    const client = await createRfb(screen, url.href);
    if (epoch !== connectionEpoch || expected !== generation || stopped) { client.disconnect(); return; }
    rfb = client;
    client.addEventListener("connect", () => { if (epoch === connectionEpoch) status.textContent = ""; });
    client.addEventListener("disconnect", () => {
      if (epoch !== connectionEpoch || stopped) return;
      status.textContent = "Connection paused. Reconnect to check the current desktop.";
      reconnect.style.display = "inline-block";
      void refresh();
    });
  } catch {
    if (epoch === connectionEpoch) { status.textContent = "The stream could not connect."; reconnect.style.display = "inline-block"; }
  } finally { if (epoch === connectionEpoch) connecting = false; }
}

async function refresh() {
  if (stopped || transitioning) return;
  try {
    const next = await request("./state");
    if (next.generation < generation || stopped) return;
    const changed = next.generation !== generation;
    generation = next.generation;
    controller = next.controller;
    updateControls();
    if (changed) { queue = Promise.resolve(); pointerDown = false; connecting = false; await connect(); }
  } catch { controller = "paused"; updateControls(); status.textContent = "The computer is unavailable. Reopen it from Fable."; }
}

async function changeControl(next) {
  if (transitioning) return;
  transitioning = true;
  updateControls();
  // Hide the old frame while native authority changes. Keep the old socket
  // until the transition completes so disconnect cannot race a return request.
  screen.style.visibility = "hidden";
  queue = Promise.resolve();
  try {
    const state = await request("./control", { generation, controller: next });
    generation = state.generation;
    controller = state.controller;
  } catch { controller = "paused"; }
  finally {
    ++connectionEpoch; rfb?.disconnect(); rfb = undefined;
    transitioning = false; connecting = false; screen.style.visibility = "visible";
    updateControls(); await refresh(); await connect();
  }
}

function send(input) {
  if (controller !== "human" || transitioning || stopped) return;
  const epoch = generation;
  queue = queue.catch(() => undefined).then(async () => {
    if (epoch !== generation || controller !== "human" || transitioning || stopped) return;
    try { await request("./input", { generation: epoch, input }); }
    catch { controller = "paused"; updateControls(); await refresh(); }
  });
}

function point(event) {
  const canvas = screen.querySelector("canvas");
  if (!canvas || !rfb?._fbWidth || !rfb?._fbHeight) return null;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const x = (event.clientX - bounds.left) * rfb._fbWidth / bounds.width;
  const y = (event.clientY - bounds.top) * rfb._fbHeight / bounds.height;
  return x >= 0 && y >= 0 && x < rfb._fbWidth && y < rfb._fbHeight ? { x, y } : null;
}
const button = (event) => event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
screen.addEventListener("pointerdown", (event) => {
  const at = point(event);
  if (!at || controller !== "human") return;
  event.preventDefault(); screen.focus(); screen.setPointerCapture(event.pointerId); pointerDown = true;
  send({ type: "pointer", action: "down", ...at, button: button(event) });
}, true);
screen.addEventListener("pointermove", (event) => {
  if (!pointerDown || performance.now() - lastMove < 33) return;
  const at = point(event); if (!at) return;
  lastMove = performance.now(); send({ type: "pointer", action: "move", ...at });
}, true);
screen.addEventListener("pointerup", (event) => {
  if (!pointerDown) return;
  pointerDown = false;
  const at = point(event) ?? { x: 0, y: 0 };
  send({ type: "pointer", action: "up", ...at, button: button(event) });
}, true);
screen.addEventListener("pointercancel", () => { pointerDown = false; send({ type: "release" }); }, true);
window.addEventListener("blur", () => { pointerDown = false; send({ type: "release" }); });
screen.addEventListener("contextmenu", (event) => event.preventDefault());
screen.addEventListener("wheel", (event) => {
  if (controller !== "human") return;
  const at = point(event); if (!at) return;
  event.preventDefault(); send({ type: "pointer", action: "scroll", ...at, deltaY: event.deltaY, deltaX: event.deltaX });
}, { passive: false, capture: true });
screen.addEventListener("keydown", (event) => {
  if (controller !== "human" || event.isComposing) return;
  if (event.key === "F6" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault(); event.stopPropagation(); resume.focus(); return;
  }
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const modifiers = [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean);
  send({ type: "key", key: event.key, modifiers });
}, true);
take.addEventListener("click", () => void changeControl("human"));
resume.addEventListener("click", () => void changeControl("agent"));
reconnect.addEventListener("click", () => void refresh().then(connect));
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (controller !== "human") return;
    send({ type: "resize", width: Math.max(640, Math.min(2560, Math.round(screen.clientWidth))), height: Math.max(480, Math.min(1600, Math.round(screen.clientHeight))) });
  }, 300);
}).observe(screen);
window.addEventListener("pagehide", () => { stopped = true; ++connectionEpoch; rfb?.disconnect(); });
setInterval(() => void refresh(), 750);
void refresh();
