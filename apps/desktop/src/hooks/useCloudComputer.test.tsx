import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useCloudComputer } from "./useCloudComputer";
const port = vi.hoisted(() => ({ cloudComputerStatus: vi.fn(), changeCloudComputer: vi.fn() }));
vi.mock("../runtime/domains/cloud-computers", () => port);
const status = { connected: true, connectionRevision: 2, machines: [] };
beforeEach(() => { vi.resetAllMocks(); port.cloudComputerStatus.mockResolvedValue(status); });
it("ignores a response for a workspace that has been left", async () => {
  let resolve!: (value: unknown) => void;
  port.cloudComputerStatus.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const hook = renderHook(({workspace}) => useCloudComputer(workspace), {initialProps:{workspace:"one"}});
  hook.rerender({workspace:"two"});
  await waitFor(() => expect(hook.result.current.status).toEqual(status));
  await act(async () => { resolve({ connected: true, connectionRevision: 90 }); });
  expect(hook.result.current.status).toEqual(status);
});
it("serializes mutations and advances the expected revision only on accepted replies", async () => {
  let resolve!: (value: unknown) => void;
  port.changeCloudComputer.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const hook = renderHook(() => useCloudComputer("one"));
  await waitFor(() => expect(hook.result.current.status).toEqual(status));
  act(() => { void hook.result.current.act({kind:"disconnect"}); void hook.result.current.act({kind:"disconnect"}); });
  expect(port.changeCloudComputer).toHaveBeenCalledExactlyOnceWith("one", 2, {kind:"disconnect"});
  await act(async () => { resolve({...status,connected:false,connectionRevision:3}); });
  port.changeCloudComputer.mockResolvedValue({...status,connectionRevision:4});
  await act(async () => hook.result.current.act({kind:"connect",agentId:"agent-one"}));
  expect(port.changeCloudComputer).toHaveBeenLastCalledWith("one", 3, {kind:"connect",agentId:"agent-one"});
});
it("does not retry an uncertain write automatically", async () => {
  port.changeCloudComputer.mockRejectedValue(new Error("Remote result unknown. Reconcile."));
  const hook = renderHook(() => useCloudComputer("one"));
  await waitFor(() => expect(hook.result.current.status).toEqual(status));
  await act(async () => hook.result.current.act({kind:"create",name:"Example"}));
  expect(hook.result.current.error).toContain("unknown");
  expect(port.changeCloudComputer).toHaveBeenCalledOnce();
});
