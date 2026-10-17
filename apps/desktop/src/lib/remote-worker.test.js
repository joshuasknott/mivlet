import {afterEach,expect,it,vi} from "vitest";
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it("handles background push with generic content and never interprets a payload",async()=>{
  const handlers=new Map();
  const showNotification=vi.fn(async()=>{});
  vi.stubGlobal("self",{addEventListener:(name,listener)=>handlers.set(name,listener),registration:{showNotification}});
  await import("../../src-tauri/src/mcp_server/remote/sw.js");
  let pending;
  const read=vi.fn(()=>"private injected task text");
  handlers.get("push")({data:{text:read},waitUntil:promise=>{pending=promise;}});
  await pending;
  expect(read).not.toHaveBeenCalled();
  expect(showNotification).toHaveBeenCalledWith("Mivlet",expect.objectContaining({body:"Shared work changed or needs your attention. Open Mivlet to review it.",tag:"mivlet-work-update"}));
});
