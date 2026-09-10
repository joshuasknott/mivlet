import { beforeEach,describe,expect,it,vi } from "vitest";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";
import {loadRuntimeLocalComputer,listRuntimeLocalComputerFiles,previewRuntimeLocalComputerFile,stageRuntimeLocalComputerAttachment,stopRuntimeAppControl} from "./runtime";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
const target={workspaceId:"workspace-a",agentId:"agent-a"};
function native(value:boolean){selectRuntimeAdapterForTest(value ? "native" : "preview");}
beforeEach(()=>{vi.resetAllMocks();native(false);});
describe("native Windows runtime boundary",()=>{
  it("does not simulate computer authority in a browser preview",async()=>{
    await expect(loadRuntimeLocalComputer(target)).resolves.toBeNull();await expect(stopRuntimeAppControl()).resolves.toBeNull();expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("exposes status and immediate Stop through fixed UI commands",async()=>{
    native(true);mocks.invoke.mockResolvedValue(null);
    await loadRuntimeLocalComputer(target);await stopRuntimeAppControl();
    expect(mocks.invoke.mock.calls).toEqual([["local_computer_status",target],["local_app_stop",{}]]);
  });
  it("keeps files explicitly workspace scoped and propagates native prerequisite errors",async()=>{
    native(true);mocks.invoke.mockResolvedValue(null);await listRuntimeLocalComputerFiles(target);await previewRuntimeLocalComputerFile({...target,path:"notes/plan.md"});
    expect(mocks.invoke).toHaveBeenCalledWith("local_computer_file_preview",{request:{...target,path:"notes/plan.md"}});
    mocks.invoke.mockRejectedValueOnce({message:"The bundled runtime checksum does not match."});
    await expect(loadRuntimeLocalComputer(target)).rejects.toThrow("checksum");
  });
  it("stages attachment bytes through one captured target and generation",async()=>{
    native(true);mocks.invoke.mockResolvedValue({ computerId:"computer-a",attachmentId:"attachment-a",originalName:"totals.csv",mimeType:"text/csv",relativePath:"Attachments/totals-a.csv",sizeBytes:4,sha256:"hash",stagedAt:"now" });
    const request={...target,expectedGeneration:7,attachmentId:"attachment-a",name:"totals.csv",mimeType:"text/csv",contentBase64:"YSxiCg=="};
    await stageRuntimeLocalComputerAttachment(request);
    expect(mocks.invoke).toHaveBeenCalledWith("local_computer_stage_attachment",{request});
  });
});
