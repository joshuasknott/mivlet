import type {
  ApprovalRiskLevel,
  ConnectorAccountSummary,
  ConnectorApprovalRecord,
  ConnectorCapability,
  ConnectorError,
  ConnectorErrorCode,
  ConnectorId,
  ConnectorPage,
  ConnectorTokenSet
} from "@fable/protocol";

export interface ConnectorAuthContext {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export interface ConnectorAuthStart {
  authorizationUrl: string;
  state: string;
}

export interface ConnectorAuthCallback {
  callbackUrl: string;
  expectedState: string;
  codeVerifier: string;
}

export interface ConnectorRequest {
  capability: string;
  input: Record<string, unknown>;
  cursor?: string;
  /** Cancels in-flight provider egress. */
  signal?: AbortSignal;
}

export interface ConnectorWriteRequest extends ConnectorRequest {
  target: string;
  preview: string;
  riskLevel: ApprovalRiskLevel;
  runId?: string;
  /** Required before the runtime may retry an ambiguous external write. */
  idempotencyKey?: string;
}

export interface ConnectorAuthResult {
  tokens: ConnectorTokenSet;
  account: ConnectorAccountSummary;
}

export interface ConnectorAdapter<TRead = unknown, TWrite = unknown> {
  readonly id: ConnectorId;
  readonly capabilities: readonly ConnectorCapability[];
  startAuth(context: ConnectorAuthContext): Promise<ConnectorAuthStart>;
  completeAuth(callback: ConnectorAuthCallback): Promise<ConnectorAuthResult>;
  refresh(tokens: ConnectorTokenSet): Promise<ConnectorTokenSet>;
  revoke(tokens: ConnectorTokenSet): Promise<void>;
  read(request: ConnectorRequest, tokens: ConnectorTokenSet): Promise<ConnectorPage<TRead>>;
  write(request: ConnectorWriteRequest, tokens: ConnectorTokenSet): Promise<TWrite>;
}

export interface ConnectorAccountSession {
  connectorId: ConnectorId;
  account: ConnectorAccountSummary;
  tokens: ConnectorTokenSet;
}

export interface ConnectorApprovalBoundary {
  /**
   * Must return a freshly approved, per-action record. Standing/session grants
   * are intentionally insufficient for consequential external writes.
   */
  approve(record: ConnectorApprovalRecord): Promise<ConnectorApprovalRecord>;
  complete(record: ConnectorApprovalRecord): Promise<void>;
}

export interface ConnectorRuntimeOptions {
  approvals: ConnectorApprovalBoundary;
  now?: () => Date;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class ConnectorRuntime {
  private readonly adapters = new Map<ConnectorId, ConnectorAdapter>();
  private readonly approvals: ConnectorApprovalBoundary;
  private readonly now: () => Date;
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ConnectorRuntimeOptions) {
    this.approvals = options.approvals;
    this.now = options.now ?? (() => new Date());
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  register(adapter: ConnectorAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Connector "${adapter.id}" is already registered.`);
    }
    const ids = new Set<string>();
    for (const capability of adapter.capabilities) {
      if (!capability.id || ids.has(capability.id)) {
        throw new Error(`Connector "${adapter.id}" has an invalid capability registry.`);
      }
      ids.add(capability.id);
    }
    this.adapters.set(adapter.id, adapter);
  }

  list(): ConnectorId[] {
    return [...this.adapters.keys()];
  }

  async disconnect(session: ConnectorAccountSession): Promise<void> {
    const adapter = this.requireAdapter(session.connectorId);
    await adapter.revoke(session.tokens);
  }

  async read<T>(
    session: ConnectorAccountSession,
    request: ConnectorRequest
  ): Promise<ConnectorPage<T>> {
    const adapter = this.requireAdapter(session.connectorId);
    this.requireCapability(adapter, request.capability, "read");
    return this.withTokenRefresh(session, (tokens) =>
      this.withRetries(() => adapter.read(request, tokens) as Promise<ConnectorPage<T>>)
    );
  }

  async write<T>(
    session: ConnectorAccountSession,
    request: ConnectorWriteRequest
  ): Promise<T> {
    const adapter = this.requireAdapter(session.connectorId);
    const capability = this.requireCapability(adapter, request.capability, "write");
    const requestedAt = this.now().toISOString();
    const record: ConnectorApprovalRecord = {
      id: `${session.connectorId}:${session.account.id}:${requestedAt}`,
      connectorId: session.connectorId,
      accountId: session.account.id,
      proposedAction: request.capability,
      target: request.target,
      preview: request.preview,
      riskLevel: request.riskLevel,
      result: "pending",
      requestId: `${session.connectorId}:${request.capability}:${requestedAt}`,
      requestedAt,
      actor: "user",
      runId: request.runId,
      actionFingerprint: `${session.connectorId}:${session.account.id}:${request.capability}:${request.target}:${request.preview}`
    };

    // All writes marked consequential by the adapter require a fresh record.
    // Fable's core registry should mark every external side effect consequential.
    if (!capability.consequential) {
      throw new Error(`External write capability "${capability.id}" must be consequential.`);
    }
    const approved = await this.approvals.approve(record);
    if (
      approved.id !== record.id ||
      approved.connectorId !== record.connectorId ||
      approved.accountId !== record.accountId ||
      approved.proposedAction !== record.proposedAction ||
      approved.target !== record.target ||
      approved.preview !== record.preview ||
      approved.riskLevel !== record.riskLevel ||
      approved.actionFingerprint !== record.actionFingerprint ||
      approved.result !== "approved" ||
      !approved.decidedAt
    ) {
      throw connectorRuntimeError(
        "approval-required",
        session.connectorId,
        "A matching explicit per-action approval is required.",
        false
      );
    }

    try {
      const result = await this.withTokenRefresh(session, (tokens) => {
        const write = () => adapter.write(request, tokens) as Promise<T>;
        return request.idempotencyKey ? this.withRetries(write) : write();
      });
      await this.approvals.complete({
        ...approved,
        result: "completed",
        executedAt: this.now().toISOString()
      });
      return result;
    } catch (error) {
      const normalized = normalizeConnectorError(session.connectorId, error);
      await this.approvals.complete({
        ...approved,
        result: "failed",
        executedAt: this.now().toISOString(),
        errorCode: normalized.code
      });
      throw normalized;
    }
  }

  private requireAdapter(id: ConnectorId): ConnectorAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Connector "${id}" is not registered.`);
    return adapter;
  }

  private requireCapability(
    adapter: ConnectorAdapter,
    id: string,
    kind: "read" | "write"
  ): ConnectorCapability {
    const capability = adapter.capabilities.find((candidate) => candidate.id === id);
    if (!capability || capability.kind !== kind) {
      throw new Error(`Connector "${adapter.id}" does not support ${kind} capability "${id}".`);
    }
    return capability;
  }

  private async withTokenRefresh<T>(
    session: ConnectorAccountSession,
    operation: (tokens: ConnectorTokenSet) => Promise<T>
  ): Promise<T> {
    if (tokenExpiresSoon(session.tokens, this.now())) {
      session.tokens = await this.requireAdapter(session.connectorId).refresh(session.tokens);
    }
    try {
      return await operation(session.tokens);
    } catch (error) {
      const normalized = normalizeConnectorError(session.connectorId, error);
      if (normalized.code !== "expired-auth") throw normalized;
      session.tokens = await this.requireAdapter(session.connectorId).refresh(session.tokens);
      return operation(session.tokens);
    }
  }

  private async withRetries<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const candidate = error as Partial<ConnectorError>;
        if (!candidate.retryable || attempt === this.maxRetries) break;
        await this.sleep(candidate.retryAfter ? Number(candidate.retryAfter) : 100 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}

export function tokenExpiresSoon(tokens: ConnectorTokenSet, now = new Date()): boolean {
  if (!tokens.expiresAt) return false;
  return Date.parse(tokens.expiresAt) <= now.getTime() + 60_000;
}

export function normalizeConnectorError(connectorId: ConnectorId, error: unknown): ConnectorError {
  if (isConnectorError(error)) return error;
  const message = error instanceof Error ? error.message : "Connector request failed.";
  return connectorRuntimeError("unknown", connectorId, message, false);
}

function isConnectorError(value: unknown): value is ConnectorError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "connectorId" in value &&
    "retryable" in value
  );
}

function connectorRuntimeError(
  code: ConnectorErrorCode,
  connectorId: ConnectorId,
  message: string,
  retryable: boolean
): ConnectorError {
  return { code, connectorId, message, retryable };
}
