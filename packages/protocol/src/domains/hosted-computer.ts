/**
 * Provider-neutral records for Fable-managed execution computers.
 *
 * These records deliberately exclude credentials, environment variables,
 * filesystem contents, command output, approval permits, and lease tokens.
 * The selected execution node owns those details inside its isolated boundary.
 */

import type { ApprovalRequest } from "./approvals.js";

export type HostedComputerLifecycle =
  | "unprovisioned"
  | "provisioning"
  | "ready"
  | "degraded"
  | "destroying"
  | "destroyed";

export type HostedProcessLifecycle =
  | "launching"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "stale";

export interface HostedComputerSnapshot {
  computerId: string;
  lifecycle: HostedComputerLifecycle;
  runtimeActive: boolean;
  keepAlive: boolean;
  generation: number;
  updatedAt: string;
}

/** Secret-free Convex control-plane projection for one teammate computer. */
export interface HostedExecutionNodeSnapshot {
  executionNodeId: string;
  workspaceId: string;
  agentId: string;
  locality: "hosted";
  status: "provisioning" | "ready" | "degraded" | "destroyed";
  runtimeActive: boolean;
  keepAlive: boolean;
  runnerGeneration: number;
  revision: number;
  updatedAt: number;
}

export interface HostedComputerProvisionReceipt {
  requestKey: string;
  executionNodeId: string;
  computerId: string;
  status: "pending" | "completed" | "failed";
}

export interface HostedProcessLaunchRequest {
  /** Stable caller key. Replays must return the original launch, not duplicate it. */
  requestKey: string;
  runId: string;
  /** Explicit argv; shell parsing is never implicit at the hosted boundary. */
  argv: readonly [string, ...string[]];
  /** Must remain below /workspace. */
  cwd?: string;
  /** Remote process lifetime, not merely an HTTP wait timeout. */
  timeoutMs?: number;
}

/** Renderer-visible draft. Rust validates it and chooses the replay-safe request key. */
export interface HostedProcessDraft {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  runId: string;
  argv: readonly [string, ...string[]];
  cwd?: string;
  timeoutMs?: number;
}

/** Immutable launch proposal returned by Rust and bound into the approval fingerprint. */
export interface HostedProcessLaunchProposal extends HostedProcessDraft {
  requestKey: string;
}

export interface PreparedHostedProcessLaunch {
  proposal: HostedProcessLaunchProposal;
  proposalFingerprint: string;
  approval: ApprovalRequest;
}

export interface HostedProcessTarget {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  processId: string;
}

export interface HostedProcessSnapshot {
  requestKey: string;
  runId: string;
  lifecycle: HostedProcessLifecycle;
  processId?: string;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  errorCode?: string;
  /** Returned only by an explicit inspection call and never persisted by coordination storage. */
  stdout?: string;
  /** Returned only by an explicit inspection call and never persisted by coordination storage. */
  stderr?: string;
  outputTruncated?: boolean;
}

/** Renderer-visible request to open a public HTTPS page in a teammate browser. */
export interface HostedBrowserNavigateDraft {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  url: string;
}

/** Immutable browser proposal returned by Rust and bound into the approval. */
export interface HostedBrowserNavigateProposal extends HostedBrowserNavigateDraft {
  requestKey: string;
}

/** Runner-facing, replay-safe browser navigation request. */
export interface HostedBrowserNavigateRequest {
  requestKey: string;
  url: string;
}

export interface PreparedHostedBrowserNavigation {
  proposal: HostedBrowserNavigateProposal;
  proposalFingerprint: string;
  approval: ApprovalRequest;
}

export const HOSTED_BROWSER_ACTIONS = ["click", "fill", "press", "select", "scroll", "history", "download"] as const;
export type HostedBrowserActionKind = (typeof HOSTED_BROWSER_ACTIONS)[number];

export const HOSTED_BROWSER_SCROLL_AMOUNTS = ["half-page-up", "half-page-down", "page-up", "page-down"] as const;
export type HostedBrowserScrollAmount = (typeof HOSTED_BROWSER_SCROLL_AMOUNTS)[number];

/** One visible control from a specific browser observation. The opaque ref is
 * usable only with the observation that produced it; models never receive CSS
 * selectors or arbitrary script execution. */
export interface HostedBrowserControl {
  ref: string;
  role: string;
  name: string;
  /** Bounded visible labels for a native select control. */
  options?: readonly string[];
}

export interface HostedBrowserActionDraft {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  observationId: string;
  elementRef: string;
  controlRole: string;
  controlName: string;
  action: HostedBrowserActionKind;
  /** Required for fill, select, and scroll. Scroll accepts only a closed viewport distance. Never use this channel for passwords or codes. */
  value?: string;
  /** Required only for press and restricted to the runner's closed key set. */
  key?: string;
}

export interface HostedBrowserActionProposal extends HostedBrowserActionDraft {
  requestKey: string;
}

export interface HostedBrowserActionRequest {
  requestKey: string;
  observationId: string;
  elementRef: string;
  controlRole: string;
  controlName: string;
  action: HostedBrowserActionKind;
  value?: string;
  key?: string;
}

export interface PreparedHostedBrowserAction {
  proposal: HostedBrowserActionProposal;
  proposalFingerprint: string;
  approval: ApprovalRequest;
}

export interface HostedBrowserTarget {
  workspaceId: string;
  agentId: string;
  deviceId: string;
}

/** Bounded viewport evidence for deciding whether another observation-scoped
 * Page scroll is useful. Values describe the top-level document only. */
export interface HostedBrowserViewportSnapshot {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

export interface HostedBrowserNavigationSnapshot {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface HostedBrowserDownloadSnapshot {
  fileName: string;
  workspacePath: string;
  bytesWritten: number;
}

/**
 * Ephemeral browser observation. Preview and Live View capabilities must never
 * be written into Convex coordination storage or durable local persistence.
 */
export interface HostedBrowserSnapshot {
  currentUrl: string;
  title: string;
  observationId: string;
  viewport: HostedBrowserViewportSnapshot;
  navigation: HostedBrowserNavigationSnapshot;
  controls: readonly HostedBrowserControl[];
  previewDataUrl: string;
  /** Short-lived Cloudflare Live View URL; present only after an approved navigation. */
  liveViewUrl?: string;
  /** Present after an approved link/control download was saved into `/workspace/downloads`. */
  lastDownload?: HostedBrowserDownloadSnapshot;
  updatedAt: string;
}
