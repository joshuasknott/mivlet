import type { PhoneRelayConnectRequest, PhoneRelayDisconnectRequest, PhoneRelayStatus } from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

async function invoke(command: string, args?: Record<string, unknown>): Promise<PhoneRelayStatus> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native") throw new Error("Connect your phone in the signed-in Mivlet desktop app.");
  try { return await adapter.invoke<PhoneRelayStatus>(command, args); }
  catch (error) { throw toRuntimeError(error); }
}
export const getPhoneRelayStatus = () => invoke("phone_relay_status");
export const connectPhoneRelay = (request: PhoneRelayConnectRequest) => invoke("phone_relay_connect", { request });
export const disconnectPhoneRelay = (request: PhoneRelayDisconnectRequest) => invoke("phone_relay_disconnect", { request });
