import {
  BACKEND_AUTH_STATE_VALUES as rootBackendAuthStateValues,
  REMOTE_PROTOCOL_VERSION as rootRemoteProtocolVersion
} from "@fable/protocol";
import {
  BACKEND_AUTH_STATE_VALUES as domainBackendAuthStateValues
} from "@fable/protocol/domains/agent-runtime";
import {
  REMOTE_PROTOCOL_VERSION as domainRemoteProtocolVersion
} from "@fable/protocol/domains/remote-control";

await Promise.all([
  import("@fable/protocol/domains/account-cloud"),
  import("@fable/protocol/domains/approvals"),
  import("@fable/protocol/domains/scheduling-workflows")
]);

if (rootBackendAuthStateValues !== domainBackendAuthStateValues) {
  throw new Error("The root and direct agent-runtime imports do not share their constant.");
}

if (rootRemoteProtocolVersion !== domainRemoteProtocolVersion) {
  throw new Error("The root and direct remote-control imports do not share their constant.");
}

console.log("Legacy root and direct protocol domain imports are compatible.");
