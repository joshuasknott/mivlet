import { BACKEND_AUTH_STATE_VALUES as rootBackendAuthStateValues } from "./index.js";
import type {
  BackendProvider as RootBackendProvider,
  VoiceCapability as RootVoiceCapability
} from "./index.js";
import { BACKEND_AUTH_STATE_VALUES as domainBackendAuthStateValues } from "./domains/agent-runtime.js";
import type { BackendProvider as DomainBackendProvider } from "./domains/agent-runtime.js";
import type { VoiceCapability as DomainVoiceCapability } from "./domains/voice.js";

type Assert<Condition extends true> = Condition;
type Exact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type _AgentRuntimeRootCompatibility = Assert<Exact<RootBackendProvider, DomainBackendProvider>>;
type _VoiceRootCompatibility = Assert<Exact<RootVoiceCapability, DomainVoiceCapability>>;

if (rootBackendAuthStateValues !== domainBackendAuthStateValues) {
  throw new Error("Legacy root and agent-runtime domain export different backend auth constants.");
}
