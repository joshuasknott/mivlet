import type { SupportedConnectorId } from "@fable/protocol";
import { SUPPORTED_CONNECTOR_IDS } from "@fable/connectors";

export function isSupportedConnectorId(value: string): value is SupportedConnectorId {
  return (SUPPORTED_CONNECTOR_IDS as readonly string[]).includes(value);
}
