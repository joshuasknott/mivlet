import type { ShellRuntime } from "../../hooks/useShellRuntime";

/** Settings needs account state and preferences, not the conversation controller. */
export type SettingsRuntime = Pick<ShellRuntime,
  | "agents"
  | "accountWorkspacePending" | "accountWorkspaceStatus"
  | "backendProviders" | "checkBackendConnection" | "connectBackendWithVerify"
  | "connectedBackendIds" | "disconnectBackend" | "exportMemory"
  | "identityPending" | "identityStatus" | "memoryDisabled" | "recoverIdentity"
  | "refreshIdentity" | "refreshModels" | "signInIdentity" | "signOutIdentity"
  | "startBackendBrowserLogin" | "toggleMemoryDisabled" | "customApprovalSettings"
  | "permissionLabel" | "selectPermissionLabel" | "setVoiceEnabled"
  | "voiceProvider" | "setVoiceProvider"
  | "updateCustomApprovalSetting" | "voiceEnabled"
  | "allModelOptions" | "hiddenModelIds" | "setModelVisible"
  | "managedMemoryRecords" | "correctMemory" | "forgetMemory" | "toggleMemoryRecordDisabled" | "memoryStatus"
>;
