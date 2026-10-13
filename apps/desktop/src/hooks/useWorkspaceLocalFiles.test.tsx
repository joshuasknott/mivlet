import { StrictMode, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, LocalComputerFilesSnapshot } from "@mivlet/protocol";
import { useWorkspaceLocalFiles } from "./useWorkspaceLocalFiles";
import { useLocalComputer } from "./useLocalComputer";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../runtime-scope";

const mocks=vi.hoisted(()=>({files:vi.fn(),load:vi.fn()}));
vi.mock("../runtime/domains/local-computer",()=>({listRuntimeLocalComputerFiles:mocks.files,loadRuntimeLocalComputer:mocks.load,
  cancelRuntimeLocalComputer:vi.fn(),previewRuntimeLocalComputerFile:vi.fn(),stopRuntimeAppControl:vi.fn()}));
const listing=(name="brief.txt"):LocalComputerFilesSnapshot=>({computerId:"computer-a",entries:[{path:name,name,kind:"file",sizeBytes:5}],truncated:false,updatedAt:"now"});
function wrapper(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const Provider=({children}:PropsWithChildren)=><QueryClientProvider client={client}>{children}</QueryClientProvider>;return {client,Provider};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const work=(agentId:string,updatedAt:string)=>({id:`work-${agentId}`,workspaceId:"workspace-a",agentId,generation:1,status:"completed",updatedAt}) as CollaborationWorkItem;
beforeEach(()=>{vi.resetAllMocks();mocks.files.mockResolvedValue(listing());mocks.load.mockResolvedValue(null);});
afterEach(()=>{cleanup();clearActiveRuntimeDataScope();vi.useRealTimers();});

it("reuses per-agent lists on reopen, reorder and addition; Refresh still rescans",async()=>{
  const {Provider}=wrapper();const first=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a","agent-b"]),{wrapper:Provider});
  await waitFor(()=>expect(first.result.current.data.every(row=>row.snapshot)).toBe(true));expect(mocks.files).toHaveBeenCalledTimes(2);
  first.unmount();
  const second=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-b","agent-a","agent-c"]),{wrapper:Provider});
  await waitFor(()=>expect(second.result.current.data.every(row=>row.snapshot)).toBe(true));expect(mocks.files).toHaveBeenCalledTimes(3);
  await act(async()=>{await second.result.current.refetch();});expect(mocks.files).toHaveBeenCalledTimes(6);
});
it("coalesces concurrent Files and inspector scans without starting status polling for Files",async()=>{
  const {Provider}=wrapper();const pending=deferred<LocalComputerFilesSnapshot>();mocks.files.mockReturnValue(pending.promise);
  const files=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  expect(mocks.load).not.toHaveBeenCalled();
  const inspector=renderHook(()=>useLocalComputer({workspaceId:"workspace-a",agentId:"agent-a",executionOwner:false}),{wrapper:Provider});
  let reading!:Promise<LocalComputerFilesSnapshot|null>;act(()=>{reading=inspector.result.current.refreshFiles();});
  expect(mocks.files).toHaveBeenCalledOnce();
  await act(async()=>{pending.resolve(listing());await reading;});
  await waitFor(()=>expect(files.result.current.data[0].snapshot?.entries).toHaveLength(1));
  expect(inspector.result.current.files?.entries).toHaveLength(1);
});
it("invalidates visible files immediately on plugin changes even without a status observer",async()=>{
  const {Provider}=wrapper();const {result}=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  await waitFor(()=>expect(result.current.data[0].snapshot).not.toBeNull());mocks.files.mockResolvedValue(listing("fresh.txt"));
  await act(async()=>{window.dispatchEvent(new Event("mivlet-builtin-plugins-changed"));});
  await waitFor(()=>expect(result.current.data[0].snapshot?.entries[0].name).toBe("fresh.txt"));expect(mocks.files).toHaveBeenCalledTimes(2);
});
it("does not inherit files after a verified account owner changes in the same workspace",async()=>{
  setActiveRuntimeDataScope("workspace-a","owner-a");const {Provider}=wrapper();
  const {result,rerender}=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  await waitFor(()=>expect(result.current.data[0].snapshot).not.toBeNull());
  setActiveRuntimeDataScope("workspace-a","owner-b");mocks.files.mockReturnValue(new Promise(()=>{}));rerender();
  expect(result.current.data[0].snapshot).toBeNull();expect(mocks.files).toHaveBeenCalledTimes(2);
});
it("refreshes only the agent whose Work changed",async()=>{
  const {Provider}=wrapper();const {result,rerender}=renderHook(({items})=>useWorkspaceLocalFiles("workspace-a",["agent-a","agent-b"],items),
    {initialProps:{items:[work("agent-a","first"),work("agent-b","first")]},wrapper:Provider});
  await waitFor(()=>expect(result.current.isFetching).toBe(false));expect(mocks.files).toHaveBeenCalledTimes(2);
  mocks.files.mockResolvedValue(listing("new.txt"));rerender({items:[work("agent-a","second"),work("agent-b","first")]});
  await waitFor(()=>expect(result.current.data.find(row=>row.agentId==="agent-a")?.snapshot?.entries[0].name).toBe("new.txt"));
  expect(mocks.files).toHaveBeenCalledTimes(3);
  expect(result.current.data.find(row=>row.agentId==="agent-b")?.snapshot?.entries[0].name).toBe("brief.txt");
});
it("fences a file scan that began before a Work file change",async()=>{
  const {Provider}=wrapper();const pending=deferred<LocalComputerFilesSnapshot>();mocks.files.mockReturnValueOnce(pending.promise);
  const {result,rerender}=renderHook(({items})=>useWorkspaceLocalFiles("workspace-a",["agent-a"],items),{initialProps:{items:[work("agent-a","first")]},wrapper:Provider});
  mocks.files.mockResolvedValue(listing("new.txt"));rerender({items:[work("agent-a","second")]});
  await act(async()=>{pending.resolve(listing("old.txt"));});
  await waitFor(()=>expect(result.current.data[0].snapshot?.entries[0].name).toBe("new.txt"));
  expect(mocks.files).toHaveBeenCalledTimes(2);
});
it("discards an old file list after a workspace switch",async()=>{
  const {Provider}=wrapper();const pending=deferred<LocalComputerFilesSnapshot>();mocks.files.mockReturnValueOnce(pending.promise);
  const {result,rerender}=renderHook(({workspaceId})=>useWorkspaceLocalFiles(workspaceId,["agent-a"]),{initialProps:{workspaceId:"first"},wrapper:Provider});
  mocks.files.mockResolvedValue(listing("second.txt"));rerender({workspaceId:"second"});
  await act(async()=>{pending.resolve(listing("first.txt"));});
  await waitFor(()=>expect(result.current.data[0].snapshot?.entries[0].name).toBe("second.txt"));
});
it("revalidates stale lists on reopen and evicts inactive metadata after thirty seconds",async()=>{
  vi.useFakeTimers();const {Provider,client}=wrapper();
  const first=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  await act(async()=>{await vi.advanceTimersByTimeAsync(50);});first.unmount();
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_001);});
  const second=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  await act(async()=>{await vi.advanceTimersByTimeAsync(50);});expect(mocks.files).toHaveBeenCalledTimes(2);second.unmount();
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_001);});
  expect(client.getQueryCache().findAll({queryKey:["local-computer-files"]})).toHaveLength(0);expect(mocks.load).not.toHaveBeenCalled();
});
it("shows native access failures instead of cached entries and retries explicitly",async()=>{
  const {Provider}=wrapper();const {result}=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  await waitFor(()=>expect(result.current.data[0].snapshot).not.toBeNull());mocks.files.mockRejectedValueOnce(new Error("Access changed"));
  await act(async()=>{await result.current.refetch();});await waitFor(()=>expect(result.current.data[0].snapshot).toBeNull());expect(result.current.data[0].error).toBe("Access changed");
  await act(async()=>{await result.current.refetch();});await waitFor(()=>expect(result.current.data[0].snapshot).not.toBeNull());
});
it("clears other consumers' cached file metadata after a native access failure",async()=>{
  const {Provider}=wrapper();const files=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),{wrapper:Provider});
  await waitFor(()=>expect(files.result.current.data[0].snapshot).not.toBeNull());
  const inspector=renderHook(()=>useLocalComputer({workspaceId:"workspace-a",agentId:"agent-a",executionOwner:false}),{wrapper:Provider});
  mocks.files.mockRejectedValueOnce(new Error("Access changed"));
  await act(async()=>{await expect(inspector.result.current.refreshFiles()).rejects.toThrow("Access changed");});
  await waitFor(()=>expect(files.result.current.data[0].snapshot).toBeNull());
});
it("loads files across development StrictMode remounts",async()=>{
  const {Provider}=wrapper();const {result}=renderHook(()=>useWorkspaceLocalFiles("workspace-a",["agent-a"]),
    {wrapper:({children}:PropsWithChildren)=><StrictMode><Provider>{children}</Provider></StrictMode>});
  await waitFor(()=>expect(result.current.data[0].snapshot?.entries).toHaveLength(1));
});
