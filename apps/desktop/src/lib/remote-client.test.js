import page from "../../src-tauri/src/mcp_server/remote/index.html?raw";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const work={id:"task-1",agentId:"atlas",request:"<img src=x onerror=alert(1)>",status:"running",generation:1,updatedAt:"now",canControl:true};
const replies={"/remote/session":{workspaceId:"default",access:"request-tasks",agents:[{id:"atlas",name:"Atlas"}]},"mivlet_work":{work:[work],truncated:false},"mivlet_request_task":work,"mivlet_stop_work":{...work,status:"cancelled"},"mivlet_read_work":{outputs:[{text:"Result text"}]}};
let calls;
let failNextMutation;
beforeEach(()=>{
  vi.resetModules();vi.useFakeTimers();document.body.innerHTML=page;
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  calls=[];failNextMutation=false;
  vi.stubGlobal("fetch",vi.fn(async(path,options)=>{
    const body=options.body && JSON.parse(options.body);calls.push({path,options,body});
    if(failNextMutation && body?.name==="mivlet_request_task"){failNextMutation=false;throw new TypeError("Network error");}
    const value=replies[body?.name || path];
    return {ok:true,status:200,json:async()=>value};
  }));
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
const start=async()=>{await import("../../src-tauri/src/mcp_server/remote/app.js");await vi.waitFor(()=>expect(document.querySelector(".task-request")).not.toBeNull());};
describe("phone client against shared task contracts",()=>{
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
