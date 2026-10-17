// No tokens or provider credentials enter this client. All dynamic content is text.
const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries(["connection","subtitle","notice","connect-panel","connect","workspace","agent","refresh","work","empty","truncated","result","result-content","close-result","composer","request","disconnect","send","read-only","retry-panel","retry","notifications"].map(id => [id, byId(id)]));
let session;
let epoch = 0;
let readVersion = 0;
let timer;
let busy = false;
let pendingMutation;
let notifications = false;
let notificationBusy = false;
let notificationVersion = 0;
const labels = {queued:"Queued",running:"Working",waiting:"Waiting",completed:"Complete",failed:"Failed",cancelled:"Stopped",blocked:"Blocked","awaiting-user":"Needs you","awaiting-approval":"Needs approval",interrupted:"Interrupted"};
const terminal = new Set(["completed","failed","cancelled"]);
const attention = new Set(["blocked","awaiting-user","awaiting-approval","interrupted"]);
let noticeOwner;
const notice = (message = "", owner) => { ui.notice.textContent = message; noticeOwner = owner; };
function lock(value) {
  busy = value;
  ui.send.disabled = value || Boolean(pendingMutation) || session?.access !== "request-tasks";
  ui.request.disabled = value || Boolean(pendingMutation) || session?.access !== "request-tasks";
  ui.connect.disabled = value;
  ui.retry.disabled = value;
  ui.agent.disabled = value || Boolean(pendingMutation);
  for (const control of ui.work.querySelectorAll("[data-mutation]")) control.disabled = value || Boolean(pendingMutation);
}
async function request(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json", "X-Mivlet-Remote": "1" }, body: JSON.stringify(body) }) });
    if (response.status === 204) return undefined;
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "The request could not be completed.");
      error.rejected = true;
      if (response.status === 401) reset("Access expired or was revoked. Connect this browser again.");
      throw error;
    }
    return result;
  } finally { clearTimeout(timeout); }
}
function reset(message) {
  ++epoch;
  clearTimeout(timer);
  session = undefined;
  pendingMutation = undefined;
  notifications = false;
  ++notificationVersion;
  notificationLabel();
  ui.work.replaceChildren();
  ui["result-content"].replaceChildren();
  ui.agent.replaceChildren();
  ui.request.value = "";
  ui.result.hidden = true;
  ui.workspace.hidden = true;
  ui["connect-panel"].hidden = false;
  ui["retry-panel"].hidden = true;
  ui.connection.textContent = "Not connected";
  ui.connection.classList.remove("connected");
  ui.subtitle.textContent = "Connect to your computer";
  notice(message);
  lock(false);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function call(name, arguments_) { return request("/remote/call", {name, arguments: arguments_}); }
async function mutate(name, arguments_, sent = false) {
  if (busy || !session || pendingMutation) return;
  pendingMutation = { name, arguments: {...arguments_, requestId: crypto.randomUUID()}, sent };
  await sendPendingMutation();
}
async function sendPendingMutation() {
  if (busy || !session || !pendingMutation) return;
  const version = epoch;
  lock(true);
  notice("Sending…");
  try {
    await request("/remote/call", {name:pendingMutation.name, arguments:pendingMutation.arguments});
    if (version !== epoch) return;
    if (pendingMutation.sent) ui.request.value = "";
    pendingMutation = undefined;
    ui["retry-panel"].hidden = true;
    notice("Request received. Approvals stay on your computer.");
    await refresh();
  } catch (error) {
    if (version !== epoch) return;
    if (error.rejected) pendingMutation = undefined;
    ui["retry-panel"].hidden = !pendingMutation;
    notice(error.rejected ? error.message : "Connection lost before confirmation. The request may have reached Mivlet.");
  } finally { if (version === epoch) lock(false); }
}
function renderWork(items) {
  const nodes = [];
  const agent = session.agents.find(agent => agent.id === ui.agent.value);
  for (const item of items) {
    const card = element("article", undefined, "card");
    const heading = element("div", undefined, "agent-heading");
    const avatar = element("span", (agent?.name || "A").slice(0,1), "avatar");
    avatar.setAttribute("aria-hidden","true");
    heading.append(avatar,element("h2", agent?.name || "Agent"),element("span",labels[item.status] || item.status,"state"));
    card.append(heading,element("p",item.request,"task-request"));
    if (attention.has(item.status)) {
      const needs = element("div",undefined,"needs-you");
      needs.append(element("strong","Needs you"),element("p","Open Mivlet on your computer to review this task and any approvals."));
      card.append(needs);
    }
    const actions = element("div",undefined,"task-actions");
    const view = element("button","View result");
    view.addEventListener("click",async () => {
      const version = epoch;
      try {
        const result = await call("mivlet_read_work", {workspaceId:session.workspaceId,agentId:item.agentId,workId:item.id});
        if (version !== epoch) return;
        const outputs = result.outputs || [];
        ui["result-content"].replaceChildren(...(outputs.length ? outputs.map(output => element("p",output.text,"result-text")) : [element("p","No saved result yet.")]));
        ui.result.hidden = false;
        ui["close-result"].focus();
      } catch (error) { if (version === epoch) notice(error.message); }
    });
    actions.append(view);
    if (item.canControl && !terminal.has(item.status)) {
      const stop = element("button","Stop task");
      stop.dataset.mutation = "stop";
      stop.disabled = busy || Boolean(pendingMutation);
      stop.addEventListener("click",() => void mutate("mivlet_stop_work",{workspaceId:session.workspaceId,agentId:item.agentId,workId:item.id,expectedGeneration:item.generation}));
      actions.append(stop);
    }
    card.append(actions);
    nodes.push(card);
  }
  ui.work.replaceChildren(...nodes);
  ui.empty.hidden = items.length > 0;
}
async function refresh() {
  clearTimeout(timer);
  if (!session || !ui.agent.value || document.hidden) return;
  const version = epoch;
  const reading = ++readVersion;
  try {
    const result = await call("mivlet_work",{workspaceId:session.workspaceId,agentId:ui.agent.value});
    if (version !== epoch || reading !== readVersion) return;
    const items = (result.work || []).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    renderWork(items);
    ui.truncated.hidden = !result.truncated;
    ui.connection.textContent = "Connected";
    ui.connection.classList.add("connected");
    if (noticeOwner === "connection") notice();
  } catch (error) {
    if (version !== epoch || reading !== readVersion || !session) return;
    ui.connection.textContent = "Offline";
    ui.connection.classList.remove("connected");
    if (!pendingMutation) notice("Your computer is unavailable. Its last shared status is shown; keep it awake with Mivlet open.", "connection");
  } finally { if (version === epoch && reading === readVersion && session) timer = setTimeout(() => void refresh(), 10000); }
}
ui.connect.addEventListener("click", async () => {
  lock(true);
  try {
    const response = await request("/remote/connect",{});
    if (!/^\/oauth\/wait\/[A-Za-z0-9_-]{43}$/.test(response.authorizeUrl)) throw new Error("The sign-in address was invalid.");
    location.assign(response.authorizeUrl);
  } catch (error) { notice(error.message); lock(false); }
});
ui.composer.addEventListener("submit", event => {
  event.preventDefault();
  const text = ui.request.value.trim();
  if (session && text && !pendingMutation) void mutate("mivlet_request_task",{workspaceId:session.workspaceId,agentId:ui.agent.value,text},true);
});
ui.retry.addEventListener("click",() => void sendPendingMutation());
ui.disconnect.addEventListener("click",async () => {
  try { await request("/remote/disconnect",{}); reset("Disconnected from this browser. Existing tasks continue on your computer."); }
  catch { notice("Could not disconnect. Revoke this browser in Mivlet Settings to end its access."); }
});
ui.refresh.addEventListener("click",() => void refresh());
ui.agent.addEventListener("change",() => { ++epoch; ui.result.hidden=true; void refresh(); });
ui["close-result"].addEventListener("click",() => { ui.result.hidden=true; ui.refresh.focus(); });
ui.notifications.hidden = !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window);
byId("notification-help").hidden = ui.notifications.hidden;
function notificationLabel(failed = false) {
  ui.notifications.textContent = notifications ? (failed ? "Delivery failed · Turn off notifications" : "Notifications on · Turn off") : "Notify when work changes";
  ui.notifications.setAttribute("aria-pressed",String(notifications));
}
async function notificationStatus(version) {
  if (ui.notifications.hidden) return;
  const reading = notificationVersion;
  try {
    const state = await request("/remote/push");
    if (version !== epoch || reading !== notificationVersion || !session) return;
    notifications = state.enabled;
    notificationLabel(state.deliveryFailed);
  } catch { /* Local HTTP and unsupported services keep the explicit opt-in. */ }
}
async function pushWorker() {
  await navigator.serviceWorker.register("/remote/sw.js",{scope:"/remote"});
  let timeout;
  try {
    return await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject) => { timeout=setTimeout(() => reject(new Error("The notification worker did not become ready. Try again.")),10000); })]);
  } finally { clearTimeout(timeout); }
}
ui.notifications.addEventListener("click",async () => {
  if (notificationBusy || !session) return;
  notificationBusy = true;
  ++notificationVersion;
  ui.notifications.disabled = true;
  const version = epoch;
  try {
    if (notifications) {
      await request("/remote/push",{endpoint:null});
      if (version !== epoch) return;
      notifications = false;
      notificationLabel();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Allow notifications in this browser before enabling them here.");
    const state = await request("/remote/push");
    const worker = await pushWorker();
    if (version !== epoch || !session) return;
    const key = Uint8Array.from(atob(state.publicKey.replace(/-/g,"+").replace(/_/g,"/")),character => character.charCodeAt(0));
    if (key.length !== 65 || key[0] !== 4) throw new Error("The notification key is invalid.");
    let subscription = await worker.pushManager.getSubscription();
    const oldKey = subscription?.options.applicationServerKey;
    if (subscription && (!oldKey || new Uint8Array(oldKey).some((value,index) => value !== key[index]) || oldKey.byteLength !== key.length)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    if (version !== epoch || !session) return;
    await request("/remote/push",{endpoint:subscription.endpoint});
    if (version !== epoch || !session) return;
    notifications = true;
    notificationLabel();
    notice("Notifications are enabled while your computer stays awake and this browser's access is valid.");
  } catch (error) { if (version === epoch) notice(error.message || "Notifications could not be enabled. Try again."); }
  finally { notificationBusy=false; ui.notifications.disabled=false; }
});
document.addEventListener("visibilitychange",() => { if (!document.hidden) void refresh(); else clearTimeout(timer); });
async function initialize() {
  const version = epoch;
  try {
    const saved = await request("/remote/session");
    if (version !== epoch) return;
    session = saved;
    ui.agent.replaceChildren(...saved.agents.map(agent => { const option = element("option",agent.name); option.value=agent.id; return option; }));
    ui["connect-panel"].hidden=true;
    ui.workspace.hidden=false;
    ui.subtitle.textContent="Connected to your computer";
    ui["read-only"].hidden=saved.access === "request-tasks";
    lock(false);
    notice("");
    await refresh();
    void notificationStatus(version);
  } catch { if (version === epoch) reset("Connect this browser to see the work you choose to share."); }
}
if (new URLSearchParams(location.search).has("connection")) { history.replaceState(null,"","/remote"); notice("Sign-in expired or was declined. Connect again when ready."); }
void initialize();
