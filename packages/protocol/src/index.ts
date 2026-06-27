export type PermissionMode = "read-only" | "trusted-scope" | "full-access";

export type ApprovalDecision = "once" | "session" | "rule" | "modify" | "deny";
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalGrantScope = "session" | "rule";

export interface ApprovalRequest {
  id: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  requestedAt: string;
  decisions: ApprovalDecision[];
  confirmationPhrase?: string;
}

export interface ApprovalModification {
  mode: PermissionMode;
  dataUsed: string[];
  consequence: string;
}

export interface ApprovalGrant {
  id: string;
  requestId: string;
  scope: ApprovalGrantScope;
  service: string;
  action: string;
  mode: PermissionMode;
  dataUsed: string[];
  createdAt: string;
}

export interface ApprovalResolutionRequest {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  decidedAt: string;
  confirmationText?: string;
  modification?: ApprovalModification;
}

export interface ApprovalResolutionResponse {
  persisted: boolean;
  auditEntry: ApprovalAuditEntry;
  effectiveRequest: ApprovalRequest;
  dismissed: boolean;
  grant?: ApprovalGrant;
}

export type MemoryKind = "fact" | "inference" | "preference" | "imported";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  title: string;
  value: string;
  source: string;
  freshness: string;
  approved: boolean;
  pinned: boolean;
}

export interface MemoryControlState {
  disabled: boolean;
  records: MemoryRecord[];
}

export interface MemoryPromotionRequest {
  source: KnowledgeSource;
  decision: ApprovalDecision;
  decidedAt: string;
  state: MemoryControlState;
}

export interface MemoryPromotionResponse {
  persisted: boolean;
  record: MemoryRecord;
  auditEntry: ApprovalAuditEntry;
  state: MemoryControlState;
}

export type FirstWaveConnectorId =
  | "github"
  | "vercel"
  | "google-drive"
  | "notion"
  | "gmail"
  | "slack"
  | "google-calendar";

export type ConnectorId = "local-files" | FirstWaveConnectorId | (string & {});

export type ConnectorStatus =
  | "fixture"
  | "needs-auth"
  | "configured"
  | "connected"
  | "expired"
  | "error"
  | "unavailable";

export type ConnectorAuthMode =
  | "none"
  | "fixture"
  | "oauth-pkce"
  | "oauth-broker"
  | "provider-installation";

export type ConnectorPermissionAccess = "read" | "write";

export interface ConnectorPermission {
  id: string;
  label: string;
  access: ConnectorPermissionAccess;
  required: boolean;
  granted: boolean;
}

export type ConnectorHealthState = "healthy" | "degraded" | "error" | "unknown";

export interface ConnectorHealth {
  state: ConnectorHealthState;
  summary: string;
  checkedAt: string;
  retryAfter?: string;
}

export interface ConnectorAccountSummary {
  id: string;
  displayName: string;
  handle?: string;
  email?: string;
  workspace?: string;
  avatarUrl?: string;
}

export interface ConnectorManifest {
  id: ConnectorId;
  name: string;
  status: ConnectorStatus;
  permissions: string[];
  healthSummary: string;
  lastCheckedAt: string;
  authMode?: ConnectorAuthMode;
  scopes?: ConnectorPermission[];
  health?: ConnectorHealth;
  account?: ConnectorAccountSummary;
  setupMessage?: string;
  supportsSearch?: boolean;
  supportsImport?: boolean;
  supportedActions?: ConnectorActionKind[];
  /**
   * Optional backend facet. When present, this connector entry surfaces an
   * agent-runtime AI backend (Codex, Cursor, Copilot, Grok) whose auth state
   * and capabilities are owned by the Rust credential boundary. The frontend
   * only ever sees `authState` and `capabilities` — never raw tokens.
   */
  backend?: BackendProvider;
}

export type ConnectorItemKind =
  | "repository"
  | "branch"
  | "issue"
  | "pull-request"
  | "file"
  | "project"
  | "deployment"
  | "page"
  | "database"
  | "message"
  | "conversation"
  | "calendar"
  | "event";

export interface ConnectorSearchRequest {
  connectorId: FirstWaveConnectorId;
  query: string;
  limit?: number;
  cursor?: string;
}

export interface ConnectorSearchItem {
  id: string;
  connectorId: FirstWaveConnectorId;
  title: string;
  kind: ConnectorItemKind;
  summary: string;
  provenance: string;
  freshness: string;
  trust: KnowledgeTrust;
  url?: string;
  contentPreview?: string;
  providerMetadata: Record<string, string>;
}

export interface ConnectorSearchResult {
  connectorId: FirstWaveConnectorId;
  query: string;
  items: ConnectorSearchItem[];
  nextCursor?: string;
  source: "fixture" | "live";
  searchedAt: string;
}

export interface ConnectorImportRequest {
  connectorId: FirstWaveConnectorId;
  item: ConnectorSearchItem;
  importedAt: string;
}

export interface ConnectorImportResult {
  source: KnowledgeSource;
  imported: boolean;
}

export type ConnectorActionKind =
  | "github.draft-pull-request"
  | "github.comment"
  | "vercel.promote"
  | "vercel.rollback"
  | "gmail.create-draft"
  | "gmail.send"
  | "slack.create-draft"
  | "slack.post"
  | "google-calendar.create-draft"
  | "google-calendar.update-draft";

export interface ConnectorActionRequest {
  id: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  payload: Record<string, string>;
  approval: ApprovalRequest;
}

export type ConnectorActionResultStatus =
  | "awaiting-approval"
  | "executed"
  | "denied"
  | "configuration-required";

export interface ConnectorActionResult {
  requestId: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  status: ConnectorActionResultStatus;
  message: string;
  providerResourceId?: string;
}

export type ConnectorErrorCode =
  | "configuration-required"
  | "needs-auth"
  | "expired-auth"
  | "permission-denied"
  | "rate-limited"
  | "provider-unavailable"
  | "not-found"
  | "invalid-request"
  | "approval-required"
  | "unknown";

export interface ConnectorError {
  code: ConnectorErrorCode;
  connectorId: FirstWaveConnectorId;
  message: string;
  retryable: boolean;
  retryAfter?: string;
}

export interface ConnectorAuthRequest {
  connectorId: FirstWaveConnectorId;
  redirectUri?: string;
}

export interface ConnectorAuthResult {
  connectorId: FirstWaveConnectorId;
  status: ConnectorStatus;
  authorizationUrl?: string;
  message: string;
}

/**
 * The transport a backend speaks. Codex reaches its app-server, Cursor and
 * Grok share a generic ACP (stdio/JSON-RPC) adapter, Copilot uses its SDK, and
 * the native-API providers (OpenAI, Anthropic, Gemini, xAI, OpenRouter) speak
 * their HTTP/SSE APIs directly — with Fable owning the entire agent loop.
 */
export type BackendType = "codex-app-server" | "acp" | "copilot-sdk" | "native-api";

/**
 * Resolved auth state for a backend instance. `install-required` and
 * `entitlement-pending` are fail-closed states: the adapter declares no
 * capabilities it cannot honor.
 */
export type BackendAuthState =
  | "connected"
  | "needs-auth"
  | "install-required"
  | "entitlement-pending"
  | "unavailable";

/**
 * The closed capability set an adapter may declare dynamically. The UI may
 * only render a control for a capability the adapter actually reported.
 */
export type BackendCapability =
  | "authentication"
  | "threads"
  | "streaming"
  | "tool-requests"
  | "approvals"
  | "file-changes"
  | "usage-cost"
  | "model-availability"
  | "cancellation";

/** A selectable model exposed by a backend. */
export interface BackendModel {
  id: string;
  label: string;
  available: boolean;
}

/**
 * Describes a connected (or connectable) agent-runtime backend. Capabilities
 * and entitlements are resolved dynamically from the current auth state —
 * adapters must never fake a capability they lack.
 */
export interface BackendProvider {
  id: string;
  backendType: BackendType;
  label: string;
  description: string;
  authState: BackendAuthState;
  capabilities: BackendCapability[];
  models: BackendModel[];
  /** Shown when `authState === "install-required"` (e.g. a missing CLI). */
  installHint?: string;
  /**
   * Entitlements detected post-login only. Grok Build is never promised for any
   * tier in fixture/preview data — it only appears here after a real check.
   */
  entitlements?: string[];
}

/**
 * Request to store a backend credential. The secret is handed to the Rust
 * credential boundary and never read back into JavaScript.
 */
export interface BackendCredentialRequest {
  providerId: string;
  secret: string;
}

/**
 * A consequential action a backend wants to perform (tool call, file write,
 * shell command). Fable routes these into its existing ApprovalRequest system
 * rather than letting the backend execute them directly.
 */
export interface BackendConsequentialEvent {
  providerId: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  /** When the backend already approved this internally, record it as audit. */
  backendPreapproved?: boolean;
}

/** An audit entry recording a backend-originated action. */
export interface BackendEventAudit {
  providerId: string;
  auditEntry: ApprovalAuditEntry;
}

export interface WorkspaceDirective {
  id: string;
  label: string;
  source: string;
  prompt: string;
  connectorIds: string[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  kind: "chat" | "project";
  description: string;
  updatedAt: string;
  pinnedContextIds: string[];
}

export interface ProjectWorkspace {
  id: string;
  title: string;
  description: string;
  threads: ThreadSummary[];
}

export type KnowledgeSourceKind = "document" | "folder" | "web" | "memory";
export type KnowledgeTrust = "trusted" | "untrusted";

export interface KnowledgeSource {
  id: string;
  title: string;
  kind: KnowledgeSourceKind;
  connectorId: string;
  provenance: string;
  freshness: string;
  pinned: boolean;
  trust?: KnowledgeTrust;
  contentPreview?: string;
  contentFingerprint?: string;
  sizeBytes?: number;
  importedAt?: string;
  origin?: "fixture" | "local-import" | "connector-import";
  providerMetadata?: Record<string, string>;
}

export interface LocalFileImport extends KnowledgeSource {
  kind: "document";
  connectorId: "local-files";
  trust: "untrusted";
  contentPreview: string;
  contentFingerprint: string;
  sizeBytes: number;
  importedAt: string;
  origin: "local-import";
}

export interface KnowledgeCitation {
  sourceId: string;
  title: string;
  snippet: string;
  provenance: string;
  freshness: string;
  trust: KnowledgeTrust;
  pinned: boolean;
  score: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  mode: "lexical-fallback" | "hybrid";
  citations: KnowledgeCitation[];
}

export type AutomationStatus = "draft" | "active" | "paused";

export interface AutomationRule {
  id: string;
  title: string;
  trigger: string;
  destination: string;
  status: AutomationStatus;
  requiresApproval: boolean;
}

export interface ApprovalAuditEntry {
  id: string;
  requestId: string;
  decision: ApprovalDecision;
  decidedAt: string;
  note: string;
}

export interface RuntimeSnapshot {
  version: 1;
  activeItem: string;
  composerDraft: string;
  voiceEnabled: boolean;
  approvalAudit: ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  approvalRules: ApprovalGrant[];
  automationStatuses: Record<string, AutomationStatus>;
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
  /**
   * Provider ids of connected agent-runtime backends. Credentials themselves
   * never live here — this only records *which* backends were connected so the
   * Rust boundary can re-resolve their auth state on recovery.
   */
  connectedBackendIds: string[];
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Native-API agent loop: events + request shaping.
//
// The TypeScript layer owns request/response shaping + the agent loop as pure,
// fixture-testable logic; the Rust boundary owns the API key + HTTP/SSE egress.
// The API key NEVER appears in any of these types — it is added as an
// Authorization/x-api-key/x-goog-api-key header inside Rust only.
// ---------------------------------------------------------------------------

/** A message role in the normalized conversation. */
export type NativeMessageRole = "system" | "user" | "assistant" | "tool";

/** A single conversation message. `toolCallId` pairs a tool result to its call. */
export interface NativeMessage {
  role: NativeMessageRole;
  content: string;
  /** Assistant tool calls, when role === "assistant" and the model requested tools. */
  toolCalls?: NativeToolCall[];
  /** Tool-result call id, when role === "tool". */
  toolCallId?: string;
}

/** A tool call the model emitted. The arguments are the raw model JSON string. */
export interface NativeToolCall {
  callId: string;
  tool: string;
  arguments: string;
}

/** A tool the loop advertises to the model (Fable-owned, from the registry). */
export interface NativeToolSpec {
  name: string;
  description: string;
  /** JSON-schema parameter shape, serialized as a string for transport. */
  parameters: string;
}

/** An Fable-owned tool the native loop may dispatch after approval. */
export interface BackendTool {
  name: string;
  description: string;
  defaultMode: PermissionMode;
  defaultRisk: ApprovalRiskLevel;
  parameters: string;
}

/** Normalized completion request the loop shapes per provider. No key, no URL. */
export interface NativeCompletionRequest {
  providerId: string;
  model: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  /** Max output tokens; provider shapers clamp to the provider's limit. */
  maxTokens: number;
}

/**
 * A normalized agent-loop event streamed back to the shell — the shared event
 * surface for the native-API loop. Model tool calls arrive as `tool-call`
 * carrying a pre-shaped ApprovalRequest so they route through Fable's existing
 * approval queue before the tool is executed.
 */
export type BackendAgentEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call";
      callId: string;
      tool: string;
      arguments: string;
      approval: ApprovalRequest;
    }
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; message: string }
  | { type: "cancelled" };
