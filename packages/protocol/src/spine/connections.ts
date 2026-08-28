import type {
  CapabilityGrantId,
  CapabilityId,
  ConnectionId,
  ExecutionNodeId,
  InternalUserId,
  IsoDateTime,
  MemberId,
  ProviderRouteId,
  ScopedRecordMetadata
} from "./primitives.js";

/** The authorized-instance shapes Fable can expose without conflating transport. */
export const CONNECTION_KINDS = [
  "native-connector",
  "provider-runtime",
  "mcp",
  "router",
  "custom-route"
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_OWNERSHIP_KINDS = ["user-owned", "workspace-shared"] as const;
export type ConnectionOwnershipKind = (typeof CONNECTION_OWNERSHIP_KINDS)[number];

export const CONNECTION_LIFECYCLE_STATES = [
  "pending-authorization",
  "authorizing",
  "authorized",
  "refresh-required",
  "revoked",
  "disconnected",
  "removed"
] as const;
export type ConnectionLifecycleState = (typeof CONNECTION_LIFECYCLE_STATES)[number];

export const CONNECTION_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "unhealthy",
  "offline"
] as const;
export type ConnectionHealthState = (typeof CONNECTION_HEALTH_STATES)[number];

export const CONNECTION_TRUST_LEVELS = [
  "first-party",
  "fable-reviewed",
  "verified-publisher",
  "user-managed",
  "untrusted"
] as const;
export type ConnectionTrustLevel = (typeof CONNECTION_TRUST_LEVELS)[number];

export const CONNECTION_AUTHORIZATION_STATES = [
  "not-required",
  "pending",
  "authorized",
  "expired",
  "denied",
  "revoked",
  "unavailable"
] as const;
export type ConnectionAuthorizationState = (typeof CONNECTION_AUTHORIZATION_STATES)[number];

/** Where a credential or session is held. These records never contain its value. */
export const CREDENTIAL_CUSTODY_KINDS = [
  "os-secure-store",
  "managed-secret-store",
  "provider-owned-session",
  "external-runtime",
  "none"
] as const;
export type CredentialCustodyKind = (typeof CREDENTIAL_CUSTODY_KINDS)[number];

export const CREDENTIAL_BINDING_STATES = [
  "not-required",
  "available",
  "refresh-required",
  "unavailable",
  "revoked",
  "unknown"
] as const;
export type CredentialBindingState = (typeof CREDENTIAL_BINDING_STATES)[number];

export const MCP_TRANSPORTS = ["stdio", "streamable-http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_DISCOVERY_STATES = ["not-started", "discovered", "stale", "failed"] as const;
export type McpDiscoveryState = (typeof MCP_DISCOVERY_STATES)[number];

export const EXECUTION_PLACEMENT_KINDS = [
  "local-desktop",
  "fable-managed",
  "customer-hosted"
] as const;
export type ExecutionPlacementKind = (typeof EXECUTION_PLACEMENT_KINDS)[number];

export const PROVIDER_ROUTE_KINDS = [
  "api-model",
  "provider-app-server",
  "acp-runtime",
  "model-router",
  "custom-agent-runtime"
] as const;
export type ProviderRouteKind = (typeof PROVIDER_ROUTE_KINDS)[number];

export const PROVIDER_ROUTE_STATES = [
  "available",
  "degraded",
  "unavailable",
  "disabled",
  "retired"
] as const;
export type ProviderRouteState = (typeof PROVIDER_ROUTE_STATES)[number];

export const CAPABILITY_AVAILABILITY_STATES = [
  "available",
  "approval-gated",
  "degraded",
  "human-assisted",
  "blocked",
  "unknown"
] as const;
export type CapabilityAvailabilityState = (typeof CAPABILITY_AVAILABILITY_STATES)[number];

export const CAPABILITY_CONSEQUENCE_CLASSES = [
  "read",
  "draft",
  "write",
  "publish",
  "destructive",
  "financial",
  "identity-sensitive"
] as const;
export type CapabilityConsequenceClass = (typeof CAPABILITY_CONSEQUENCE_CLASSES)[number];

export const CAPABILITY_IMPLEMENTATION_EVIDENCE_KINDS = [
  "declared",
  "discovered",
  "adapter-validated",
  "live-validated",
  "user-confirmed",
  "unavailable"
] as const;
export type CapabilityImplementationEvidenceKind =
  (typeof CAPABILITY_IMPLEMENTATION_EVIDENCE_KINDS)[number];

export const CAPABILITY_GRANT_STATES = [
  "active",
  "suspended",
  "expired",
  "revoked"
] as const;
export type CapabilityGrantState = (typeof CAPABILITY_GRANT_STATES)[number];

export const CAPABILITY_GRANT_COMPOSITION_MODES = ["default-deny", "all-applicable-must-allow"] as const;
export type CapabilityGrantCompositionMode = (typeof CAPABILITY_GRANT_COMPOSITION_MODES)[number];

export const CAPABILITY_APPROVAL_REQUIREMENT_KINDS = [
  "not-required",
  "required-for-every-action",
  "required-by-consequence",
  "policy-determined"
] as const;
export type CapabilityApprovalRequirementKind =
  (typeof CAPABILITY_APPROVAL_REQUIREMENT_KINDS)[number];

export const CAPABILITY_RESOLUTION_FAILURE_CODES = [
  "capability-unknown",
  "no-eligible-connection",
  "connection-not-authorized",
  "connection-unhealthy",
  "credential-unavailable",
  "route-unavailable",
  "placement-unavailable",
  "grant-missing",
  "grant-expired-or-revoked",
  "scope-denied",
  "consequence-denied",
  "budget-exhausted",
  "approval-required",
  "trust-insufficient",
  "privacy-boundary",
  "billing-boundary",
  "provider-boundary",
  "placement-boundary",
  "implementation-unverified"
] as const;
export type CapabilityResolutionFailureCode = (typeof CAPABILITY_RESOLUTION_FAILURE_CODES)[number];

export const CAPABILITY_DEGRADATION_REASONS = [
  "limited-scope",
  "limited-model-or-tool-support",
  "requires-human-assistance",
  "stale-discovery",
  "provider-rate-limited",
  "provider-offline",
  "credential-refresh-required",
  "policy-restricted",
  "unverified-implementation"
] as const;
export type CapabilityDegradationReason = (typeof CAPABILITY_DEGRADATION_REASONS)[number];

/**
 * A catalogue reference, never an authorized external account. Existing
 * connector manifests are compatibility sources for this reference only.
 */
export interface ConnectorDefinitionReference {
  definitionKey: string;
  definitionVersion?: string;
  publisher?: string;
}

/**
 * Secret-free locator for a credential boundary. `bindingReference` is opaque
 * to product clients and is not a token, password, OAuth response, cookie, or
 * PKCE verifier.
 */
export interface CredentialBindingMetadata {
  custody: CredentialCustodyKind;
  state: CredentialBindingState;
  bindingReference?: string;
  lastValidatedAt?: IsoDateTime;
  expiresAt?: IsoDateTime;
  refreshSupported: boolean;
}

/** An opaque external identity hint for display and audit, never Fable identity. */
export interface ExternalPrincipalReference {
  provider: string;
  opaqueSubjectReference?: string;
  displayLabel?: string;
}

export interface ConnectionEnablementScope {
  enabledByDefault: boolean;
}

export interface ConnectionHealth {
  state: ConnectionHealthState;
  checkedAt?: IsoDateTime;
  summary?: string;
  retryAfter?: IsoDateTime;
}

export interface ConnectionAuthorization {
  state: ConnectionAuthorizationState;
  authorizedAt?: IsoDateTime;
  expiresAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export interface NativeConnectorConnectionDetails {
  kind: "native-connector";
  connector: ConnectorDefinitionReference;
  externalPrincipal?: ExternalPrincipalReference;
}

export interface ProviderRuntimeConnectionDetails {
  kind: "provider-runtime";
  providerFamily: string;
  runtimeProtocol: "provider-api" | "app-server" | "acp" | "other";
}

export interface McpToolEnablement {
  toolName: string;
  enabled: boolean;
}

export interface McpResourceEnablement {
  resourcePattern: string;
  enabled: boolean;
}

export interface McpConnectionDetails {
  kind: "mcp";
  transport: McpTransport;
  /** STDIO launch details remain at the local runtime boundary. */
  localLaunchReference?: string;
  /** Remote server address is configuration, not credential material. */
  remoteEndpoint?: string;
  discoveryState: McpDiscoveryState;
  discoveredAt?: IsoDateTime;
  enabledTools?: readonly McpToolEnablement[];
  enabledResources?: readonly McpResourceEnablement[];
}

export interface RouterConnectionDetails {
  kind: "router";
  routerFamily: string;
  routingProtocol: string;
}

export interface CustomRouteConnectionDetails {
  kind: "custom-route";
  adapterFamily: string;
  adapterVersion?: string;
}

export type ConnectionTransportDetails =
  | NativeConnectorConnectionDetails
  | ProviderRuntimeConnectionDetails
  | McpConnectionDetails
  | RouterConnectionDetails
  | CustomRouteConnectionDetails;

/**
 * A workspace-bound, authorized instance. It deliberately does not expose an
 * account ID, access token, provider session, command line, or secret value.
 */
export type Connection = ScopedRecordMetadata & {
  id: ConnectionId;
  recordType: "connection";
  displayName: string;
  ownership: ConnectionOwnershipKind;
  lifecycle: ConnectionLifecycleState;
  authorization: ConnectionAuthorization;
  health: ConnectionHealth;
  trust: ConnectionTrustLevel;
  credentialBinding: CredentialBindingMetadata;
  enablement: ConnectionEnablementScope;
  transport: ConnectionTransportDetails;
};

export interface ExecutionPlacementRequirement {
  allowedKinds: readonly ExecutionPlacementKind[];
  eligibleNodeIds?: readonly ExecutionNodeId[];
  /** A route must not use a node unless the node can honor this residency. */
  requiredDataResidency?: string;
  requiresCredentialHoldingNode: boolean;
}

export interface RouteBoundaryPolicy {
  privacyBoundary: string;
  billingBoundary: string;
  providerBoundary: string;
  placementBoundary: string;
}

export interface ProviderRouteBudgetLimit {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostMinorUnits?: number;
  currency?: string;
  maxWallClockSeconds?: number;
}

/** A permitted model or agent execution path exposed by exactly one Connection. */
export type ProviderRoute = ScopedRecordMetadata & {
  id: ProviderRouteId;
  recordType: "provider-route";
  connectionId: ConnectionId;
  kind: ProviderRouteKind;
  displayName: string;
  providerFamily: string;
  modelOrRuntimeReference: string;
  state: ProviderRouteState;
  health: ConnectionHealth;
  placement: ExecutionPlacementRequirement;
  boundaries: RouteBoundaryPolicy;
  budgetLimit?: ProviderRouteBudgetLimit;
  credentialBinding: CredentialBindingMetadata;
  discoveredAt?: IsoDateTime;
};

/** A transport-neutral action identity requested by a conversation tool call. */
export interface CapabilityDescriptor {
  id: CapabilityId;
  namespace: string;
  key: string;
  displayName: string;
  description: string;
  supportedConsequences: readonly CapabilityConsequenceClass[];
  inputSchemaReference?: string;
  outputSchemaReference?: string;
}

/** Evidence must name the concrete implementation without redefining the capability. */
export interface CapabilityImplementationEvidence {
  kind: CapabilityImplementationEvidenceKind;
  observedAt: IsoDateTime;
  observedBy?: InternalUserId;
  adapterReference?: string;
  detail?: string;
  expiresAt?: IsoDateTime;
}

export interface CapabilityImplementation {
  capabilityId: CapabilityId;
  connectionId: ConnectionId;
  providerRouteId?: ProviderRouteId;
  availability: CapabilityAvailabilityState;
  supportedConsequences: readonly CapabilityConsequenceClass[];
  evidence: readonly CapabilityImplementationEvidence[];
  degradationReasons?: readonly CapabilityDegradationReason[];
  requiresHumanAssistance?: boolean;
}

export interface CapabilityBudgetConstraint {
  maxUses?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostMinorUnits?: number;
  currency?: string;
  maxWallClockSeconds?: number;
}

/** Scope constraints are conjunctive: omitted dimensions do not widen another grant. */
export interface CapabilityGrantConstraints {
  memberIds?: readonly MemberId[];
  eligibleConnectionIds?: readonly ConnectionId[];
  eligibleProviderRouteIds?: readonly ProviderRouteId[];
  eligibleExecutionNodeIds?: readonly ExecutionNodeId[];
  allowedPlacementKinds?: readonly ExecutionPlacementKind[];
  allowedDestinationPatterns?: readonly string[];
  allowedConsequences: readonly CapabilityConsequenceClass[];
  budget?: CapabilityBudgetConstraint;
}

/** Standing policy only; this is never a decision over an exact proposed action. */
export interface CapabilityApprovalRequirement {
  kind: CapabilityApprovalRequirementKind;
  consequences?: readonly CapabilityConsequenceClass[];
  freshnessWindowSeconds?: number;
}

/**
 * A workspace-owned least-authority statement. The resolver uses default deny:
 * no active matching grant means no execution, and overlapping grants can only
 * narrow the authority that is effective for the request.
 */
export type CapabilityGrant = ScopedRecordMetadata & {
  id: CapabilityGrantId;
  recordType: "capability-grant";
  capabilityId: CapabilityId;
  state: CapabilityGrantState;
  composition: CapabilityGrantCompositionMode;
  constraints: CapabilityGrantConstraints;
  approvalRequirement: CapabilityApprovalRequirement;
  grantedByInternalUserId: InternalUserId;
  grantedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
  revokedByInternalUserId?: InternalUserId;
  revocationReason?: string;
};

/** A request-specific routing boundary. Any fallback must preserve every value. */
export interface CapabilityResolutionBoundary {
  privacyBoundary: string;
  billingBoundary: string;
  providerBoundary: string;
  placementBoundary: string;
}

export const CAPABILITY_FALLBACK_POLICIES = ["none", "same-boundary-only"] as const;
export type CapabilityFallbackPolicy = (typeof CAPABILITY_FALLBACK_POLICIES)[number];

export interface CapabilityResolutionContext {
  memberId: MemberId;
  executionNodeId?: ExecutionNodeId;
}

export interface CapabilityResolutionRequest {
  workspaceId: Connection["workspaceId"];
  capabilityId: CapabilityId;
  consequence: CapabilityConsequenceClass;
  context: CapabilityResolutionContext;
  boundaries: CapabilityResolutionBoundary;
  fallbackPolicy: CapabilityFallbackPolicy;
  preferredConnectionIds?: readonly ConnectionId[];
  preferredProviderRouteIds?: readonly ProviderRouteId[];
  requiredTrust?: ConnectionTrustLevel;
  requestedAt: IsoDateTime;
}

export interface ResolvedCapabilityTarget {
  capabilityId: CapabilityId;
  connectionId: ConnectionId;
  providerRouteId?: ProviderRouteId;
  availability: Extract<CapabilityAvailabilityState, "available" | "approval-gated" | "degraded" | "human-assisted">;
  implementationEvidence: readonly CapabilityImplementationEvidence[];
  matchedGrantIds: readonly CapabilityGrantId[];
  approvalRequirement: CapabilityApprovalRequirement;
  placement: ExecutionPlacementRequirement;
  boundaries: CapabilityResolutionBoundary;
  degradationReasons?: readonly CapabilityDegradationReason[];
}

export interface CapabilityResolutionFailure {
  code: CapabilityResolutionFailureCode;
  message: string;
  connectionId?: ConnectionId;
  providerRouteId?: ProviderRouteId;
  retryAfter?: IsoDateTime;
}

export const CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION =
  "fable.connected-source-search.v1" as const;

/** Fable-owned citation shape shared by native and MCP source-search routes. */
export interface ConnectedSourceCitation {
  citationId: string;
  sourceId: string;
  title: string;
  snippet: string;
  uri?: string;
  provenance: string;
  freshness: string;
  trust: "external-untrusted";
}

/**
 * Provider-neutral result consumed by the model when producing a cited brief.
 * External implementations supply source facts only; Fable stamps scope,
 * trust, authority, Connection, grants, and implementation evidence.
 */
export interface ConnectedSourceSearchResult {
  contractVersion: typeof CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION;
  capabilityId: "knowledge.content.search";
  query: string;
  scope: { workspaceId: string; threadId?: string };
  citations: readonly ConnectedSourceCitation[];
  nextCursor?: string;
  trust: "external-untrusted";
  instructionAuthority: "none";
  degraded: boolean;
  degradationReasons: readonly string[];
  connectionId: ConnectionId;
  matchedGrantIds: readonly CapabilityGrantId[];
  implementation: {
    kind: "native" | "mcp";
    evidence: CapabilityImplementationEvidenceKind;
  };
}

export type CapabilityResolutionResult =
  | {
      status: "resolved";
      target: ResolvedCapabilityTarget;
      failuresConsidered?: readonly CapabilityResolutionFailure[];
    }
  | {
      status: "unresolved";
      failures: readonly CapabilityResolutionFailure[];
    };
