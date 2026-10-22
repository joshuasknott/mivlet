import type {
  AgentComputerPreference,
  ApprovalRequest,
  HostedBrowserSnapshot,
} from "@mivlet/protocol";

export interface DesktopToolExecutorOptions {
  connectorIds?: readonly string[];
  connectorAccessCurrent?: (connectorId: string) => boolean;
  /** Connection identity selected now; mutations bind to the prepared account instead. */
  connectorAccountCurrent?: (connectorId: string) => string | undefined;
  workspaceId?: string;
  /** Native durable Work identity; required for every computer effect. */
  workId?: string;
  workGeneration?: number;
  /** Immutable preference captured at Work admission; never infer this from UI state. */
  computerPreference?: AgentComputerPreference;
  localComputer?: {
    workspaceId: string;
    agentId: string;
    ready: boolean;
    generation?: number;
    controller?: "agent" | "human" | "paused";
  };
  /** Current scope/authority, including during an in-flight approval. */
  localComputerCurrent?: () => DesktopToolExecutorOptions["localComputer"];
  prepareLocalComputer?: (tool: string) => Promise<void>;
  shouldCancel?: () => boolean;
  onExecuting?: (approval: ApprovalRequest, tool: string) => void;
  hostedComputer?: {
    workspaceId: string;
    agentId: string;
    deviceId: string;
    ready: boolean;
  };
  queueApproval?: (
    approval: ApprovalRequest,
    tool: string,
    argumentsJson: string
  ) => void;
  onHostedBrowserSnapshot?: (snapshot: HostedBrowserSnapshot) => void;
}
