import {
  BACKEND_AUTH_STATE_VALUES as rootBackendAuthStateValues,
  CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION as rootConnectedSourceSearchVersion
} from "@mivlet/protocol";
import {
  BACKEND_AUTH_STATE_VALUES as domainBackendAuthStateValues
} from "@mivlet/protocol/domains/agent-runtime";
import { CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION as domainConnectedSourceSearchVersion } from "@mivlet/protocol/domains/connected-source-search";

await Promise.all([
  import("@mivlet/protocol/domains/account-cloud"),
  import("@mivlet/protocol/domains/agent-runtime"),
  import("@mivlet/protocol/domains/approvals"),
  import("@mivlet/protocol/domains/collaboration"),
  import("@mivlet/protocol/domains/connected-source-search"),
  import("@mivlet/protocol/domains/connectors"),
  import("@mivlet/protocol/domains/hosted-computer"),
  import("@mivlet/protocol/domains/hosted-execution-capability"),
  import("@mivlet/protocol/domains/local-computer"),
  import("@mivlet/protocol/domains/local-projects"),
  import("@mivlet/protocol/domains/provider-routing"),
  import("@mivlet/protocol/domains/search"),
  import("@mivlet/protocol/domains/voice")
]);

if (rootBackendAuthStateValues !== domainBackendAuthStateValues) {
  throw new Error("The root and direct agent-runtime imports do not share their constant.");
}
if (rootConnectedSourceSearchVersion !== domainConnectedSourceSearchVersion) {
  throw new Error("The root and direct connected-source-search imports do not share their constant.");
}

console.log("Root and direct protocol domain imports are compatible.");
