import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRiskLevel,
  BrowserAutomationActionDecision,
  BrowserAutomationActionRequest,
  BrowserAutomationActionStatus,
  BrowserAutomationFailureCode,
  BrowserAutomationSession,
  PermissionMode,
  PermissionProfileId,
  RecordActionHistoryRequest
} from "@fable/protocol";
import {
  effectForBrowserAction,
  evaluatePermissionPolicy,
  type PermissionEffect
} from "./permission-policy";

export interface BrowserAutomationGuardOptions {
  /** A real browser transport exists for this session. Defaults to false. */
  transportAvailable?: boolean;
  /** Current time for TTL checks. Defaults to Date.now. */
  now?: Date;
}

export interface BrowserAutomationGuardResult {
  decision: BrowserAutomationActionDecision;
  audit: RecordActionHistoryRequest[];
}

interface BrowserActionPolicy {
  effect: PermissionEffect;
  riskLevel: ApprovalRiskLevel;
  consequence: string;
}

const READ_ACTIONS = new Set(["browser.read-url", "browser.read-title"]);

const BROWSER_ACTION_POLICY: Record<string, BrowserActionPolicy> = {
  "browser.read-url": {
    effect: "browser-read",
    riskLevel: "low",
    consequence: "Read the current browser tab URL without page contents."
  },
  "browser.read-title": {
    effect: "browser-read",
    riskLevel: "low",
    consequence: "Read the current browser tab title without page contents."
  },
  "browser.navigate": {
    effect: "browser-state-mutation",
    riskLevel: "medium",
    consequence: "Navigate the active browser tab to a user-visible destination."
  },
  "browser.click": {
    effect: "browser-state-mutation",
    riskLevel: "high",
    consequence: "Click a user-visible browser control."
  },
  "browser.type": {
    effect: "browser-state-mutation",
    riskLevel: "high",
    consequence: "Type into a user-visible browser field."
  },
  "browser.select": {
    effect: "browser-state-mutation",
    riskLevel: "high",
    consequence: "Select an option in a user-visible browser control."
  },
  "browser.submit": {
    effect: "publish-external",
    riskLevel: "critical",
    consequence: "Submit a browser form or commit a browser interaction."
  },
  "browser.download": {
    effect: "local-write",
    riskLevel: "high",
    consequence: "Download a browser resource into the local workspace."
  },
  "browser.upload": {
    effect: "publish-external",
    riskLevel: "critical",
    consequence: "Upload a local file through the browser."
  },
  "browser.screenshot": {
    effect: "browser-state-mutation",
    riskLevel: "high",
    consequence: "Capture a screenshot of the visible browser viewport."
  },
  "browser.clipboard-read": {
    effect: "browser-state-mutation",
    riskLevel: "critical",
    consequence: "Read clipboard state through the browser boundary."
  },
  "browser.clipboard-write": {
    effect: "publish-external",
    riskLevel: "critical",
    consequence: "Write clipboard state through the browser boundary."
  }
};

export function createBrowserAutomationSession(input: {
  id: string;
  runId: string;
  createdAt: string;
  expiresAt: string;
  permissionMode?: PermissionMode;
  permissionProfile?: PermissionProfileId;
}): BrowserAutomationSession {
  return {
    id: input.id,
    runId: input.runId,
    state: "active",
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    permissionMode: input.permissionMode ?? "read-only",
    permissionProfile: input.permissionProfile
  };
}

export class BrowserAutomationBoundary {
  private readonly attempted = new Map<string, BrowserAutomationActionDecision>();
  private readonly approved = new Set<string>();
  private readonly finished = new Set<string>();

  constructor(
    private readonly session: BrowserAutomationSession,
    private readonly options: BrowserAutomationGuardOptions = {}
  ) {}

  prepare(request: BrowserAutomationActionRequest): BrowserAutomationGuardResult {
    const attempted = auditEvent(request, this.session, "attempted", {
      riskLevel: policyFor(request.action)?.riskLevel ?? "critical",
      mode: this.session.permissionMode,
      summary: `${request.action} requested`
    });
    const preflight = this.preflight(request, { markAttempt: true });
    if (preflight) {
      return { decision: preflight, audit: [attempted, auditFromDecision(request, this.session, preflight)] };
    }

    const policy = policyFor(request.action)!;
    const permission = evaluatePermissionPolicy({
      mode: this.session.permissionMode,
      profile: this.session.permissionProfile,
      effect: policy.effect,
      riskLevel: policy.riskLevel
    });
    if (!permission.allowed) {
      const decision = this.decision(request, "denied", policy, "permission-denied", permission.reason);
      this.attempted.set(request.id, decision);
      return { decision, audit: [attempted, auditFromDecision(request, this.session, decision)] };
    }

    const approvalRequired = permission.approvalRequired || !READ_ACTIONS.has(request.action);
    const status: BrowserAutomationActionStatus = approvalRequired
      ? "approval-required"
      : "safe/read-only";
    const decision = this.decision(
      request,
      status,
      policy,
      approvalRequired ? "approval-required" : undefined,
      permission.reason,
      approvalRequired ? this.approvalFor(request, policy) : undefined
    );
    this.attempted.set(request.id, decision);
    return { decision, audit: [attempted, auditFromDecision(request, this.session, decision)] };
  }

  resolveApproval(
    request: BrowserAutomationActionRequest,
    decision: Extract<ApprovalDecision, "once" | "deny">
  ): BrowserAutomationGuardResult {
    const preflight = this.preflight(request, { markAttempt: false });
    if (preflight) {
      return { decision: preflight, audit: [auditFromDecision(request, this.session, preflight)] };
    }
    const prepared = this.attempted.get(request.id);
    if (!prepared || prepared.status !== "approval-required") {
      const denied = this.denied(request, "approval-missing", "No pending browser approval matches this action.");
      return { decision: denied, audit: [auditFromDecision(request, this.session, denied)] };
    }
    if (decision === "deny") {
      const denied = this.denied(request, "approval-denied", "The user denied this browser action.");
      this.attempted.set(request.id, denied);
      return { decision: denied, audit: [auditFromDecision(request, this.session, denied)] };
    }
    const approved = {
      ...prepared,
      status: "approved" as const,
      failureCode: undefined,
      message: "The browser action was explicitly approved."
    };
    this.approved.add(request.id);
    this.attempted.set(request.id, approved);
    return { decision: approved, audit: [auditFromDecision(request, this.session, approved)] };
  }

  complete(
    request: BrowserAutomationActionRequest,
    outcome: { ok: true } | { ok: false; message: string }
  ): BrowserAutomationGuardResult {
    const preflight = this.preflight(request, { markAttempt: false });
    if (preflight) {
      return { decision: preflight, audit: [auditFromDecision(request, this.session, preflight)] };
    }
    if (this.finished.has(request.id)) {
      const denied = this.denied(request, "replayed-action", "This browser action already completed.");
      return { decision: denied, audit: [auditFromDecision(request, this.session, denied)] };
    }

    const prepared = this.attempted.get(request.id);
    if (!prepared) {
      const denied = this.denied(request, "approval-missing", "This browser action was never prepared.");
      return { decision: denied, audit: [auditFromDecision(request, this.session, denied)] };
    }
    if (prepared.status === "approval-required" && !this.approved.has(request.id)) {
      const denied = this.denied(request, "approval-missing", "This browser action needs explicit approval first.");
      return { decision: denied, audit: [auditFromDecision(request, this.session, denied)] };
    }
    if (!["safe/read-only", "approved"].includes(prepared.status)) {
      const denied = this.denied(request, prepared.failureCode ?? "permission-denied", prepared.message);
      return { decision: denied, audit: [auditFromDecision(request, this.session, denied)] };
    }

    this.finished.add(request.id);
    const status = outcome.ok ? "completed" : "failed";
    const completed = {
      ...prepared,
      status,
      failureCode: outcome.ok ? undefined : "execution-failed",
      message: outcome.ok ? "The browser action completed." : outcome.message
    } satisfies BrowserAutomationActionDecision;
    this.attempted.set(request.id, completed);
    return { decision: completed, audit: [auditFromDecision(request, this.session, completed)] };
  }

  private preflight(
    request: BrowserAutomationActionRequest,
    options: { markAttempt: boolean }
  ): BrowserAutomationActionDecision | null {
    const policy = policyFor(request.action);
    const fallbackPolicy: BrowserActionPolicy = policy ?? {
      effect: effectForBrowserAction(request.action) ?? "browser-state-mutation",
      riskLevel: "critical",
      consequence: "Refuse unsupported browser automation."
    };

    const invalid = validateRequestBinding(request, this.session, this.now());
    if (invalid) {
      return this.decision(request, "denied", fallbackPolicy, invalid.code, invalid.message);
    }
    if (options.markAttempt && this.attempted.has(request.id)) {
      return this.decision(
        request,
        "denied",
        fallbackPolicy,
        "replayed-action",
        "This browser action id was already used."
      );
    }
    if (!policy) {
      return this.decision(
        request,
        "denied",
        fallbackPolicy,
        "unsupported-action",
        "This browser automation action is not supported."
      );
    }
    if (!this.options.transportAvailable) {
      return this.decision(
        request,
        "unavailable",
        policy,
        "transport-unavailable",
        "Browser automation is unavailable in this runtime."
      );
    }
    return null;
  }

  private decision(
    request: BrowserAutomationActionRequest,
    status: BrowserAutomationActionStatus,
    policy: BrowserActionPolicy,
    failureCode?: BrowserAutomationFailureCode,
    message = "",
    approval?: ApprovalRequest
  ): BrowserAutomationActionDecision {
    return {
      requestId: request.id,
      runId: request.runId,
      sessionId: request.sessionId,
      action: request.action,
      status,
      riskLevel: policy.riskLevel,
      mode: this.session.permissionMode,
      permissionProfile: this.session.permissionProfile,
      approval,
      failureCode,
      message
    };
  }

  private denied(
    request: BrowserAutomationActionRequest,
    code: BrowserAutomationFailureCode,
    message: string
  ): BrowserAutomationActionDecision {
    return this.decision(
      request,
      "denied",
      policyFor(request.action) ?? BROWSER_ACTION_POLICY["browser.submit"],
      code,
      message
    );
  }

  private approvalFor(
    request: BrowserAutomationActionRequest,
    policy: BrowserActionPolicy
  ): ApprovalRequest {
    return {
      id: `browser-${request.runId}-${request.sessionId}-${request.id}`
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 160),
      service: "browser-automation",
      action: request.action,
      mode: this.session.permissionMode,
      permissionProfile: this.session.permissionProfile,
      riskLevel: policy.riskLevel,
      dataUsed: safeDataUsed(request),
      consequence: policy.consequence,
      requestedAt: request.requestedAt,
      decisions: ["once", "deny"],
      confirmationPhrase:
        policy.riskLevel === "high" || policy.riskLevel === "critical"
          ? `approve ${request.action}`
          : undefined
    };
  }

  private now(): Date {
    return this.options.now ?? new Date();
  }
}

export function policyFor(action: string): BrowserActionPolicy | null {
  const policy = BROWSER_ACTION_POLICY[action];
  if (!policy) return null;
  return policy;
}

function validateRequestBinding(
  request: BrowserAutomationActionRequest,
  session: BrowserAutomationSession,
  now: Date
): { code: BrowserAutomationFailureCode; message: string } | null {
  if (request.runId !== session.runId) {
    return { code: "cross-run", message: "Browser action belongs to a different run." };
  }
  if (request.sessionId !== session.id) {
    return {
      code: "cross-session",
      message: "Browser action belongs to a different browser session."
    };
  }
  const requestedAt = Date.parse(request.requestedAt);
  const createdAt = Date.parse(session.createdAt);
  const expiresAt = Date.parse(session.expiresAt);
  if (
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    session.state !== "active" ||
    requestedAt < createdAt ||
    requestedAt > expiresAt ||
    now.getTime() > expiresAt
  ) {
    return { code: "stale-action", message: "Browser action is stale or expired." };
  }
  return null;
}

function safeDataUsed(request: BrowserAutomationActionRequest): string[] {
  return [
    `session: ${request.sessionId}`,
    `run: ${request.runId}`,
    request.pageOrigin ? `origin: ${redactBrowserAuditText(request.pageOrigin)}` : "",
    request.targetLabel ? `target: ${redactBrowserAuditText(request.targetLabel)}` : ""
  ].filter(Boolean);
}

function auditFromDecision(
  request: BrowserAutomationActionRequest,
  session: BrowserAutomationSession,
  decision: BrowserAutomationActionDecision
): RecordActionHistoryRequest {
  return auditEvent(request, session, decision.status, {
    riskLevel: decision.riskLevel,
    mode: decision.mode,
    errorCode: decision.failureCode,
    summary: decision.message || `${request.action} ${decision.status}`
  });
}

function auditEvent(
  request: BrowserAutomationActionRequest,
  session: BrowserAutomationSession,
  status: string,
  input: {
    riskLevel: ApprovalRiskLevel;
    mode: PermissionMode;
    summary: string;
    errorCode?: string;
  }
): RecordActionHistoryRequest {
  return {
    category: "web-action",
    service: "browser-automation",
    action: request.action,
    status,
    actor: "system",
    riskLevel: input.riskLevel,
    mode: input.mode,
    correlationId: `${request.runId}:${session.id}:${request.id}`,
    errorCode: input.errorCode,
    summary: redactBrowserAuditText(input.summary),
    detail: {
      requestId: request.id,
      runId: request.runId,
      sessionId: session.id,
      action: request.action,
      pageOrigin: request.pageOrigin ? redactBrowserAuditText(request.pageOrigin) : undefined,
      targetLabel: request.targetLabel ? redactBrowserAuditText(request.targetLabel) : undefined,
      hasArguments: Object.keys(request.arguments ?? {}).length > 0
    }
  };
}

function redactBrowserAuditText(value: string): string {
  const normalized = value.split(/\s+/).filter(Boolean).join(" ");
  const lower = normalized.toLowerCase();
  if (
    [
      "authorization:",
      "bearer ",
      "cookie",
      "access_token",
      "refresh_token",
      "client_secret",
      "api_key",
      "apikey",
      "x-api-key",
      "password",
      "secret",
      "clipboard",
      "dom dump",
      "screenshot",
      "page content",
      "body:"
    ].some((marker) => lower.includes(marker))
  ) {
    return "[redacted]";
  }
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 160)}...`;
}
