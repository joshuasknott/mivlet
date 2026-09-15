import type { SupportedConnectorId } from "@mivlet/protocol";
import { SUPPORTED_CONNECTOR_IDS } from "@mivlet/connectors";

export function isSupportedConnectorId(value: string): value is SupportedConnectorId {
  return (SUPPORTED_CONNECTOR_IDS as readonly string[]).includes(value);
}
