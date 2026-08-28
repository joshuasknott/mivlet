import { BACKEND_AUTH_STATE_VALUES as rootBackendAuthStateValues } from "@fable/protocol";
import {
  BACKEND_AUTH_STATE_VALUES as domainBackendAuthStateValues
} from "@fable/protocol/domains/agent-runtime";
await Promise.all([
  import("@fable/protocol/domains/account-cloud"),
  import("@fable/protocol/domains/approvals"),
  import("@fable/protocol/domains/hosted-computer"),
  import("@fable/protocol/domains/local-computer"),
  import("@fable/protocol/domains/voice")
]);

if (rootBackendAuthStateValues !== domainBackendAuthStateValues) {
  throw new Error("The root and direct agent-runtime imports do not share their constant.");
}

console.log("Root and direct protocol domain imports are compatible.");
