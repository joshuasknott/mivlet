import {
  BACKEND_AUTH_STATE_VALUES as rootBackendAuthStateValues,
  CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION as rootConnectedSourceSearchVersion
} from "@fable/protocol";
import {
  BACKEND_AUTH_STATE_VALUES as domainBackendAuthStateValues
} from "@fable/protocol/domains/agent-runtime";
import { CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION as domainConnectedSourceSearchVersion } from "@fable/protocol/domains/connected-source-search";

await Promise.all([
  import("@fable/protocol/domains/account-cloud"),
  import("@fable/protocol/domains/agent-runtime"),
  import("@fable/protocol/domains/approvals"),
  import("@fable/protocol/domains/collaboration"),
  import("@fable/protocol/domains/connected-source-search"),
  import("@fable/protocol/domains/connectors"),
  import("@fable/protocol/domains/hosted-computer"),
  import("@fable/protocol/domains/hosted-execution-capability"),
  import("@fable/protocol/domains/local-computer"),
  import("@fable/protocol/domains/local-projects"),
  import("@fable/protocol/domains/provider-routing"),
  import("@fable/protocol/domains/search"),
  import("@fable/protocol/domains/voice")
]);

if (rootBackendAuthStateValues !== domainBackendAuthStateValues) {
  throw new Error("The root and direct agent-runtime imports do not share their constant.");
}
if (rootConnectedSourceSearchVersion !== domainConnectedSourceSearchVersion) {
  throw new Error("The root and direct connected-source-search imports do not share their constant.");
}

console.log("Root and direct protocol domain imports are compatible.");
