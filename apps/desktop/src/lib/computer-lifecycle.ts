import type { LocalComputerLifecycleRequest, LocalComputerSnapshot } from "@fable/protocol";
import { getRuntimeAdapter, hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { toRuntimeError } from "../runtime/errors";

export async function changeComputerLifecycle(request: LocalComputerLifecycleRequest): Promise<LocalComputerSnapshot> {
  if (!hasNativeRuntimeAdapter()) throw new Error("Manage this computer in the Fable desktop app.");
  return getRuntimeAdapter().invoke<LocalComputerSnapshot>("local_computer_lifecycle", { request }).catch((error: unknown) => { throw toRuntimeError(error); });
}
