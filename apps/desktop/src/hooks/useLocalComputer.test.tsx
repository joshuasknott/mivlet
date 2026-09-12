import { StrictMode, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalComputerSnapshot } from "@fable/protocol";
import { useLocalComputer } from "./useLocalComputer";
const mocks=vi.hoisted(()=>({load:vi.fn(),files:vi.fn(),preview:vi.fn(),stop:vi.fn(),cancel:vi.fn()}));
vi.mock("../runtime",()=>({loadRuntimeLocalComputer:mocks.load,listRuntimeLocalComputerFiles:mocks.files,previewRuntimeLocalComputerFile:mocks.preview,
  stopRuntimeAppControl:mocks.stop,cancelRuntimeLocalComputer:mocks.cancel}));
const idle={status:"idle" as const,requestId:null,generation:null,application:null,title:null,message:null};
const node=(overrides:Partial<LocalComputerSnapshot>={}):LocalComputerSnapshot=>({computerId:"computer-a",workspaceId:"workspace-a",agentId:"agent-a",locality:"local",backend:"cua-driver",isolation:"windows-session",lifecycle:"ready",controller:"agent",generation:1,capabilities:["persistent-files"],runtimeAvailable:true,retiredComputer:false,plugins:{computer:true},control:idle,updatedAt:"2026-09-09T00:00:00Z",...overrides});
const active=()=>node({control:{...idle,status:"active",requestId:"request-a",generation:1,application:"Disposable app",title:"Fixture"}});
function wrapper(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});return({children}:PropsWithChildren)=><QueryClientProvider client={client}>{children}</QueryClientProvider>;}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
const hook=()=>renderHook(()=>useLocalComputer({workspaceId:"workspace-a",agentId:"agent-a"}),{wrapper:wrapper()});
beforeEach(()=>{vi.resetAllMocks();mocks.load.mockResolvedValue(node());mocks.files.mockResolvedValue(null);mocks.preview.mockResolvedValue(null);mocks.stop.mockResolvedValue(undefined);mocks.cancel.mockResolvedValue(null);});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe("native local computer",()=>{
  it("loads capabilities after a development StrictMode remount without cancelling idle control",async()=>{
    const Provider=wrapper();
    const {result}=renderHook(()=>useLocalComputer({workspaceId:"workspace-a",agentId:"agent-a"}),{wrapper:({children}:PropsWithChildren)=><StrictMode><Provider>{children}</Provider></StrictMode>});
    await waitFor(()=>expect(result.current.node?.plugins?.computer).toBe(true));
    await act(async()=>{await expect(result.current.prepareForTool("read-file")).resolves.toMatchObject({computerId:"computer-a"});});
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("joins an initial status query when execution immediately requests capabilities",async()=>{
    const pending=deferred<LocalComputerSnapshot>(); mocks.load.mockReturnValue(pending.promise);
    const {result}=hook(); let prepared!:Promise<LocalComputerSnapshot>;
    act(()=>{prepared=result.current.prepareForTool("read-file");});
    expect(mocks.load).toHaveBeenCalledOnce();
    await act(async()=>{pending.resolve(node());expect(await prepared).toMatchObject({plugins:{computer:true}});});
    await waitFor(()=>expect(result.current.node?.plugins?.computer).toBe(true));
  });
  it("distinguishes missing capabilities from a disabled plugin",async()=>{
    const {result}=hook();await waitFor(()=>expect(result.current.node).not.toBeNull());
    mocks.load.mockResolvedValue(null);
    await expect(result.current.prepareForTool("read-file")).rejects.toThrow("Computer status is unavailable");
    mocks.load.mockResolvedValue(node({plugins:{computer:false}}));
    await expect(result.current.prepareForTool("read-file")).rejects.toThrow("Enable Computer Use");
  });
  it("shows a manual refresh failure and recovers when the runtime responds",async()=>{
    const {result}=hook();await waitFor(()=>expect(result.current.node).not.toBeNull());
    mocks.load.mockRejectedValueOnce(new Error("The native runtime has disconnected."));
    await act(async()=>{await expect(result.current.refresh()).rejects.toThrow("native runtime has disconnected");});
    expect(result.current.node).toBeNull();expect(result.current.error).toBe("The native runtime has disconnected.");
    await act(async()=>{await result.current.refresh();});
    expect(result.current.node?.plugins?.computer).toBe(true);expect(result.current.error).toBeNull();
  });
  it("backs off idle status reads to thirty seconds without capturing images",async()=>{
    vi.useFakeTimers();hook();await act(async()=>{await vi.advanceTimersByTimeAsync(50);});expect(mocks.load).toHaveBeenCalledOnce();
    await act(async()=>{await vi.advanceTimersByTimeAsync(29_000);});expect(mocks.load).toHaveBeenCalledOnce();
    await act(async()=>{await vi.advanceTimersByTimeAsync(1_000);});expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  it("refreshes immediately on plugin changes and polls active control every two seconds",async()=>{
    vi.useFakeTimers();const{result}=hook();await act(async()=>{await vi.advanceTimersByTimeAsync(50);});mocks.load.mockResolvedValue(active());
    await act(async()=>{window.dispatchEvent(new Event("fable-builtin-plugins-changed"));await vi.advanceTimersByTimeAsync(50);});expect(result.current.node?.control.status).toBe("active");
    await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});expect(mocks.load).toHaveBeenCalledTimes(3);
  });
  it("prepares model discovery through the ordinary tool route without a UI permission grant",async()=>{
    const{result}=hook();await waitFor(()=>expect(result.current.node).not.toBeNull());
    await expect(result.current.prepareForTool("local-app-list")).resolves.toMatchObject({computerId:"computer-a"});
    await expect(result.current.prepareForTool("write-file")).resolves.toMatchObject({computerId:"computer-a"});
    expect(result.current).not.toHaveProperty("allowControl");
  });
  it("Stop during connection discards an outstanding status result",async()=>{
    mocks.load.mockResolvedValue(node({control:{...idle,status:"connecting",requestId:"pending",generation:1,application:"Fixture"}}));
    const{result}=hook();await waitFor(()=>expect(result.current.busy).toBe(true));
    const late=deferred<LocalComputerSnapshot>();mocks.load.mockReturnValueOnce(late.promise);let reading!:Promise<unknown>;
    act(()=>{reading=result.current.refresh();});
    mocks.load.mockResolvedValue(node({generation:2}));
    await act(async()=>{await result.current.stop();});
    await act(async()=>{late.resolve(active());await reading;});
    expect(mocks.stop).toHaveBeenCalledOnce();expect(result.current.node?.generation).toBe(2);expect(result.current.node?.control.status).toBe("idle");expect(result.current.busy).toBe(false);
  });
  it("does not project a status from a previous workspace after a scope change",async()=>{
    const late=deferred<LocalComputerSnapshot>();mocks.load.mockReturnValueOnce(late.promise);
    const{result,rerender}=renderHook(({agentId})=>useLocalComputer({workspaceId:"workspace-a",agentId}),{initialProps:{agentId:"agent-a"},wrapper:wrapper()});
    mocks.load.mockResolvedValue(node({agentId:"agent-b",computerId:"computer-b"}));rerender({agentId:"agent-b"});
    await act(async()=>{late.resolve(active());});await waitFor(()=>expect(result.current.node?.agentId).toBe("agent-b"));
  });
  it("discards an old file preview after generation changes",async()=>{
    const late=deferred<unknown>();mocks.preview.mockReturnValue(late.promise);const{result}=hook();await waitFor(()=>expect(result.current.node).not.toBeNull());
    let reading!:Promise<unknown>;act(()=>{reading=result.current.previewFile("report.txt");});mocks.load.mockResolvedValue(node({generation:2}));
    await act(async()=>{await result.current.refresh();late.resolve({computerId:"computer-a",path:"report.txt",content:"old",sizeBytes:3,truncated:false,updatedAt:"now"});await reading;});expect(result.current.filePreview).toBeNull();
  });
  it("rejects decreasing generations and a status from a different agent",async()=>{
    mocks.load.mockResolvedValue(node({generation:4}));const{result}=hook();await waitFor(()=>expect(result.current.node?.generation).toBe(4));
    mocks.load.mockResolvedValue(node({generation:2}));await act(async()=>{await result.current.refresh();});expect(result.current.node?.generation).toBe(4);
    mocks.load.mockResolvedValue(node({agentId:"agent-other",generation:5}));await act(async()=>{await result.current.refresh();});expect(result.current.node?.agentId).toBe("agent-a");
  });
  it("requests scope cancellation on unmount with active permission",async()=>{
    mocks.load.mockResolvedValue(active());const{result,unmount}=hook();await waitFor(()=>expect(result.current.node?.control.status).toBe("active"));unmount();
    expect(mocks.cancel).toHaveBeenCalledWith({workspaceId:"workspace-a",agentId:"agent-a",expectedGeneration:1});
  });
});
