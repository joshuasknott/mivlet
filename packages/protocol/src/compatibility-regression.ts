import {
  BACKEND_AUTH_STATE_VALUES as rootBackendAuthStateValues,
  REMOTE_PROTOCOL_VERSION as rootRemoteProtocolVersion
} from "./index.js";
import type {
  BackendProvider as RootBackendProvider,
  CloudWorkspaceLinkState as RootCloudWorkspaceLinkState,
  RemoteEnvelopeV1 as RootRemoteEnvelopeV1,
  ScheduledJob as RootScheduledJob,
  WorkflowDefinition as RootWorkflowDefinition
} from "./index.js";
import { BACKEND_AUTH_STATE_VALUES as domainBackendAuthStateValues } from "./domains/agent-runtime.js";
import type { BackendProvider as DomainBackendProvider } from "./domains/agent-runtime.js";
import type { CloudWorkspaceLinkState as DomainCloudWorkspaceLinkState } from "./domains/account-cloud.js";
import {
  REMOTE_PROTOCOL_VERSION as domainRemoteProtocolVersion
} from "./domains/remote-control.js";
import type { RemoteEnvelopeV1 as DomainRemoteEnvelopeV1 } from "./domains/remote-control.js";
import type {
  ScheduledJob as DomainScheduledJob,
  WorkflowDefinition as DomainWorkflowDefinition
} from "./domains/scheduling-workflows.js";

type Assert<Condition extends true> = Condition;
type Exact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type _AccountCloudRootCompatibility = Assert<
  Exact<RootCloudWorkspaceLinkState, DomainCloudWorkspaceLinkState>
>;
type _SchedulingRootCompatibility = Assert<Exact<RootScheduledJob, DomainScheduledJob>>;
type _WorkflowRootCompatibility = Assert<
  Exact<RootWorkflowDefinition, DomainWorkflowDefinition>
>;
type _AgentRuntimeRootCompatibility = Assert<Exact<RootBackendProvider, DomainBackendProvider>>;
type _RemoteControlRootCompatibility = Assert<Exact<RootRemoteEnvelopeV1, DomainRemoteEnvelopeV1>>;

if (rootBackendAuthStateValues !== domainBackendAuthStateValues) {
  throw new Error("Legacy root and agent-runtime domain export different backend auth constants.");
}

if (rootRemoteProtocolVersion !== domainRemoteProtocolVersion) {
  throw new Error("Legacy root and remote-control domain export different protocol versions.");
}
