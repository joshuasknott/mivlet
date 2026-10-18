import type { ReactNode } from "react";
import type {
  ConnectorManifest,
  MivletAgentProfile,
  ProjectFact,
  Spine,
} from "@mivlet/protocol";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import type { ConversationMessageView } from "../../lib/conversation-runtime";
import type { ConversationTurn } from "../../lib/conversation-presentation-types";
import type { PreviewFeedbackSource } from "../../lib/preview-feedback";
import type { McpAppApprovalPreview } from "../../lib/mcp-app-host";
import type { AgentPresence } from "../../lib/agent-presence";

export interface ConversationFeedProps {
  messages: ConversationMessageView[];
  agent: MivletAgentProfile;
  authors?: Record<string, MivletAgentProfile>;
  requireAuthor?: boolean;
  showAuthor?: boolean;
  suppressLivePrompt?: boolean;
  state: NativeAgentState;
  liveStates?: {
    state: NativeAgentState;
    agent: MivletAgentProfile;
    suppressPrompt: boolean;
  }[];
  presence?: AgentPresence;
  threadId?: string;
  profileName: string;
  connectors: ConnectorManifest[];
  optimisticPrompt: string;
  pendingTurns?: ConversationTurn[];
  decisionEvents?: ProjectFact[];
  optimisticAttachments?: readonly Spine.Conversations.ConversationAttachmentMetadata[];
  workspaceId: string;
  generation?: number;
  selectedHeadId?: string;
  onSelectBranch?: (headId: string) => void;
  branchSelectionPending?: boolean;
  hasOlderMessages?: boolean;
  branchHeadIds?: readonly string[];
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  approval?: ReactNode;
  awaitingApprovalRunIds?: readonly string[];
  interruption?: ReactNode;
  onPreviewArtifact?: (
    output: string,
    authorId?: string,
    messageId?: string,
  ) => void;
  onOpenConnector?: (connectorId: string) => void;
  /** Places an interactive response revision or selected passage in the composer. */
  onDraftResponse?: (text: string) => void;
  onDraftPreview?: (text: string, source: PreviewFeedbackSource) => void;
  /** Saves a deliberately selected response passage through the native memory boundary. */
  onSaveMemory?: (title: string, value: string) => Promise<void>;
  /** Opens a confirmed decision at its durable conversation source. */
  onOpenDecision?: (fact: ProjectFact) => void;
  onPinResponse?: (
    text: string,
    source: { messageId?: string; sourceRevisionId?: string },
    runId: string,
    agentId: string,
  ) => Promise<void>;
  /** Routes MCP App resource/tool requests into the existing approval UI. */
  appGeneration?: number;
  isMcpRunCurrent?: (runId: string) => boolean;
  onMcpAppApproval?: (
    preview: McpAppApprovalPreview,
  ) => Promise<import("@mivlet/protocol").ApprovalResolutionRequest | null>;
  onMcpAppResourceRegister?: (
    resource: import("../../lib/mcp-app-host").McpAppResource | undefined,
    owner: { resultId: string; sessionId: string },
  ) => Promise<string | null>;
  onMcpAppResourceRelease?: (owner: {
    resultId: string;
    sessionId: string;
  }) => Promise<void>;
  onOpenWorkspaceFiles?: (agentId: string) => void;
}
