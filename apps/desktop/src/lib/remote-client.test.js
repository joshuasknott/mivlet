import page from "../../src-tauri/src/mcp_server/remote/index.html?raw";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const work={id:"task-1",agentId:"atlas",request:"<img src=x onerror=alert(1)>",status:"running",generation:1,updatedAt:"now",canControl:true};
const replies={"/remote/session":{workspaceId:"default",access:"request-tasks",agents:[{id:"atlas",name:"Atlas"}]},"mivlet_work":{work:[work],truncated:false},"mivlet_request_task":work,"mivlet_stop_work":{...work,status:"cancelled"},"mivlet_read_work":{outputs:[{text:"Result text"}]}};
let calls;
let failNextMutation;
let failNextRead;
beforeEach(()=>{
  history.replaceState(null,"","/remote");
  vi.resetModules();vi.useFakeTimers();document.body.innerHTML=page;
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  calls=[];failNextMutation=false;failNextRead=false;
  vi.stubGlobal("fetch",vi.fn(async(path,options)=>{
    const body=options.body && JSON.parse(options.body);calls.push({path,options,body});
    if(failNextMutation && body?.name==="mivlet_request_task"){failNextMutation=false;throw new TypeError("Network error");}
    if(failNextRead && body?.name==="mivlet_work"){failNextRead=false;throw new TypeError("Network error");}
    const value=replies[body?.name || path];
    return {ok:true,status:200,json:async()=>value};
  }));
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
const start=async()=>{await import("../../src-tauri/src/mcp_server/remote/app.js");await vi.waitFor(()=>expect(document.querySelector(".task-request")).not.toBeNull());};
describe("phone client against shared task contracts",()=>{
  it("discloses omitted saved results even when no complete output fits",async()=>{
    const normal=fetch.getMockImplementation();
    fetch.mockImplementation(async(path,options)=>{
      if(options.body && JSON.parse(options.body).name==="mivlet_read_work") return {ok:true,status:200,json:async()=>({outputs:[],truncated:true})};
      return normal(path,options);
    });
    await start();
    Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="View result").click();
    await vi.waitFor(()=>expect(document.getElementById("result").hidden).toBe(false));
    expect(document.getElementById("result-content").textContent).toContain("Some saved results were omitted");
    expect(document.getElementById("result-content").textContent).toContain("Open Mivlet on your computer");
    expect(document.getElementById("result-content").textContent).not.toContain("No saved result yet");
  });
  it("keeps the newest result selection and does not reopen a closed pending read",async()=>{
    const normal=fetch.getMockImplementation();const reads=[];
    fetch.mockImplementation(async(path,options)=>{
      if(options.body && JSON.parse(options.body).name==="mivlet_read_work") return new Promise(resolve=>{reads.push(text=>resolve({ok:true,status:200,json:async()=>({outputs:[{text}]})}));});
      return normal(path,options);
    });
    await start();
    const view=Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="View result");
    view.click();view.click();await vi.waitFor(()=>expect(reads).toHaveLength(2));
    reads[1]("Latest selected result");await vi.waitFor(()=>expect(document.getElementById("result-content").textContent).toBe("Latest selected result"));
    reads[0]("Older slow result");await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("result-content").textContent).toBe("Latest selected result");
    view.click();await vi.waitFor(()=>expect(reads).toHaveLength(3));
    document.getElementById("close-result").click();reads[2]("Should stay closed");await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("result").hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("refresh"));
  });
  it("uses only its managed base path and keeps the entire consent exchange native",async()=>{
    const prefix=`/d/${"a".repeat(64)}`;history.replaceState(null,"",`${prefix}/remote`);
    let connected=false;
    fetch.mockImplementation(async(path,options)=>{
      const body=options.body && JSON.parse(options.body);calls.push({path,options,body});
      const route=path.slice(prefix.length);
      if(route==="/remote/session" && !connected) return {ok:false,status:401,json:async()=>({error:"Connect first"})};
      if(route==="/remote/connect") return {ok:true,status:200,json:async()=>({pending:true})};
      if(route==="/remote/consent") {connected=true;return {ok:true,status:200,json:async()=>({connected:true})};}
      return {ok:true,status:200,json:async()=>replies[body?.name || route]};
    });
    await import("../../src-tauri/src/mcp_server/remote/app.js");
    await vi.waitFor(()=>expect(document.getElementById("notice").textContent).toContain("Connect this browser"));
    document.getElementById("connect").click();
    await vi.advanceTimersByTimeAsync(1501);
    await vi.waitFor(()=>expect(document.querySelector(".task-request")).not.toBeNull());
    expect(calls.every(call=>call.path.startsWith(`${prefix}/remote/`))).toBe(true);
    expect(calls.some(call=>call.path.includes("oauth"))).toBe(false);
    expect(calls.some(call=>JSON.stringify(call.body ?? {}).includes("code_verifier"))).toBe(false);
  });
  it("keeps an HTTP503 write uncertain and reuses its original ID only on explicit retry",async()=>{
    const normal=fetch.getMockImplementation();let unavailable=true;
    fetch.mockImplementation(async(path,options)=>{
      const result=await normal(path,options);
      if(unavailable && options.body && JSON.parse(options.body).name==="mivlet_request_task") {
        unavailable=false;return {ok:false,status:503,json:async()=>({error:"Connection lost before confirmation"})};
      }
      return result;
    });
    await start();document.getElementById("request").value="Exactly one request";
    document.getElementById("composer").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(document.getElementById("retry-panel").hidden).toBe(false));
    const original=calls.find(call=>call.body?.name==="mivlet_request_task").body;
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls.filter(call=>call.body?.name==="mivlet_request_task")).toHaveLength(1);
    document.getElementById("retry").click();
    await vi.waitFor(()=>expect(document.getElementById("retry-panel").hidden).toBe(true));
    expect(calls.filter(call=>call.body?.name==="mivlet_request_task")[1].body).toEqual(original);
  });
  it("does not let an old notification status read replace an accepted opt-in",async()=>{
    const key=new Uint8Array(65);key[0]=4;
    const state={publicKey:btoa(String.fromCharCode(...key)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"),enabled:false,deliveryFailed:false};
    replies["/remote/push"]=state;
    const registration={pushManager:{getSubscription:async()=>null,subscribe:async()=>({endpoint:"https://fcm.googleapis.com/fcm/send/fixture",options:{applicationServerKey:key.buffer}})}};
    vi.stubGlobal("Notification",{requestPermission:async()=>"granted"});
    vi.stubGlobal("PushManager",class {});
    vi.stubGlobal("navigator",{serviceWorker:{register:async()=>registration,ready:Promise.resolve(registration)}});
    const fetchNormally=fetch.getMockImplementation();
    let release;
    fetch.mockImplementation(async(path,options)=>{
      if(path==="/remote/push" && options.method==="GET" && !release) {
        return new Promise(resolve=>{release=()=>resolve({ok:true,status:200,json:async()=>state});});
      }
      return fetchNormally(path,options);
    });
    await start();
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    document.getElementById("notifications").click();
    await vi.waitFor(()=>expect(document.getElementById("notifications").getAttribute("aria-pressed")).toBe("true"));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("notifications").getAttribute("aria-pressed")).toBe("true");
  });
  it("enables and disables native push with only the browser endpoint",async()=>{
    const key=new Uint8Array(65);key[0]=4;
    replies["/remote/push"]={publicKey:btoa(String.fromCharCode(...key)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"),enabled:false,deliveryFailed:false};
    const subscribe=vi.fn(async()=>({endpoint:"https://fcm.googleapis.com/fcm/send/fixture",options:{applicationServerKey:key.buffer}}));
    const registration={pushManager:{getSubscription:vi.fn(async()=>null),subscribe}};
    vi.stubGlobal("Notification",{requestPermission:vi.fn(async()=>"granted")});
    vi.stubGlobal("PushManager",class {});
    vi.stubGlobal("navigator",{serviceWorker:{register:vi.fn(async()=>registration),ready:Promise.resolve(registration)}});
    await start();
    document.getElementById("notifications").click();
    await vi.waitFor(()=>expect(document.getElementById("notifications").getAttribute("aria-pressed")).toBe("true"));
    expect(subscribe).toHaveBeenCalledWith({userVisibleOnly:true,applicationServerKey:key});
    expect(calls.find(call=>call.path==="/remote/push" && call.body)?.body).toEqual({endpoint:"https://fcm.googleapis.com/fcm/send/fixture"});
    document.getElementById("notifications").click();
    await vi.waitFor(()=>expect(document.getElementById("notifications").getAttribute("aria-pressed")).toBe("false"));
    expect(calls.filter(call=>call.path==="/remote/push" && call.body).at(-1).body).toEqual({endpoint:null});
  });
  it("clears only connection-owned notices after reconnecting",async()=>{
    await start();failNextRead=true;
    document.getElementById("refresh").click();
    await vi.waitFor(()=>expect(document.getElementById("connection").textContent).toBe("Offline"));
    expect(document.getElementById("notice").textContent).toContain("unavailable");
    document.getElementById("refresh").click();
    await vi.waitFor(()=>expect(document.getElementById("connection").textContent).toBe("Connected"));
    expect(document.getElementById("notice").textContent).toBe("");
  });
  it("renders untrusted task text without HTML and posts only closed action data",async()=>{
    await start();
    expect(document.querySelector(".task-request").textContent).toBe(work.request);
    expect(document.querySelector(".task-request img")).toBeNull();
    document.getElementById("request").value="Review the homepage";
    document.getElementById("composer").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(document.getElementById("send").disabled).toBe(false));
    const submitted=calls.find(call=>call.body?.name==="mivlet_request_task");
    expect(Object.keys(submitted.body).sort()).toEqual(["arguments","name"]);
    expect(submitted.body.arguments.text).toBe("Review the homepage");
    expect(submitted.options.credentials).toBe("same-origin");
    expect(submitted.options.headers.Authorization).toBeUndefined();
    expect(document.getElementById("request").value).toBe("");
  });
  it("retains uncertain writes and retries the exact idempotency key deliberately",async()=>{
    await start();failNextMutation=true;
    document.getElementById("request").value="One request";
    document.getElementById("composer").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(document.getElementById("retry-panel").hidden).toBe(false));
    expect(document.getElementById("request").value).toBe("One request");
    const original=calls.find(call=>call.body?.name==="mivlet_request_task").body;
    const stop=document.querySelector("[data-mutation=stop]");
    expect(stop.disabled).toBe(true);
    // Even a dispatched event cannot turn another action into an implicit retry.
    stop.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.filter(call=>call.body?.name==="mivlet_request_task")).toHaveLength(1);
    expect(calls.filter(call=>call.body?.name==="mivlet_stop_work")).toHaveLength(0);
    expect(document.querySelector("[data-mutation=stop]").disabled).toBe(true);
    document.getElementById("retry").click();
    await vi.waitFor(()=>expect(document.getElementById("retry-panel").hidden).toBe(true));
    const mutations=calls.filter(call=>call.body?.name==="mivlet_request_task");
    expect(mutations).toHaveLength(2);expect(mutations[1].body).toEqual(original);
    expect(document.getElementById("send").disabled).toBe(false);
    expect(document.querySelector("[data-mutation=stop]").disabled).toBe(false);
  });
});
