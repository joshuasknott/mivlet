import {afterEach,expect,it,vi} from "vitest";
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it("handles background push with generic content and never interprets a payload",async()=>{
  const handlers=new Map();
  const showNotification=vi.fn(async()=>{});
  vi.stubGlobal("self",{addEventListener:(name,listener)=>handlers.set(name,listener),registration:{showNotification,scope:"https://phone.example/remote"}});
  await import("../../src-tauri/src/mcp_server/remote/sw.js");
  let pending;
  const read=vi.fn(()=>"private injected task text");
  handlers.get("push")({data:{text:read},waitUntil:promise=>{pending=promise;}});
  await pending;
  expect(read).not.toHaveBeenCalled();
  expect(showNotification).toHaveBeenCalledWith("Mivlet",expect.objectContaining({body:"Shared work changed or needs your attention. Open Mivlet to review it.",tag:"mivlet-work-update"}));
});
it("opens only its exact managed device path after a generic notification",async()=>{
  const path=`/d/${"a".repeat(64)}/remote`;
  const handlers=new Map(),openWindow=vi.fn(async()=>{}),focus=vi.fn();
  vi.stubGlobal("self",{addEventListener:(name,listener)=>handlers.set(name,listener),location:{origin:"https://phone.example"},
    registration:{scope:`https://phone.example${path}/`,showNotification:vi.fn()},
    clients:{matchAll:async()=>[{url:"https://phone.example/remote",focus}],openWindow}});
  await import("../../src-tauri/src/mcp_server/remote/sw.js");
  let pending;
  handlers.get("notificationclick")({notification:{data:{path:"https://attacker.example"},close:vi.fn()},waitUntil:p=>{pending=p;}});
  await pending;
  expect(openWindow).toHaveBeenCalledWith(path);expect(focus).not.toHaveBeenCalled();
});
