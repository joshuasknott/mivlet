import type {
  PhoneRelayConnectRequest,
  PhoneRelayDisconnectRequest,
  PhoneRelayStatus,
} from "@mivlet/protocol";
import { invokeRequiredNative } from "../required-native";

const invoke = (command: string, args?: Record<string, unknown>) =>
  invokeRequiredNative<PhoneRelayStatus>(
    command,
    args,
    "Connect your phone in the signed-in Mivlet desktop app.",
  );
export const getPhoneRelayStatus = () => invoke("phone_relay_status");
export const connectPhoneRelay = (request: PhoneRelayConnectRequest) =>
  invoke("phone_relay_connect", { request });
export const disconnectPhoneRelay = (request: PhoneRelayDisconnectRequest) =>
  invoke("phone_relay_disconnect", { request });
