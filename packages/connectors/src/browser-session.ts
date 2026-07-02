import type {
  ApprovalDecision,
  BrowserSessionState,
  ConnectorActionRequest,
  ConnectorActionResult,
  ConnectorManifest,
  ConnectorSearchResult,
  FirstWaveConnectorId,
  PermissionMode
} from "@fable/protocol";
import { effectForConnectorAction, evaluatePermissionPolicy } from "./permission-policy";
import { FIRST_WAVE_CONNECTOR_IDS } from "./providers/registry";

const FIXTURE_SESSION_TTL_MS = 30 * 60 * 1000;

const SECRET_KEY_PATTERN =
  /(^|[-_.])(authorization|cookie|cookies|token|tokens|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|code[_-]?verifier|pkce|dom|html|screenshot|clipboard|page[_-]?text|localstorage|sessionstorage)([-_.]|$)/i;
const SECRET_VALUE_PATTERN =
  /(bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]+|gh[pousr]_[a-z0-9_]{20,}|-----BEGIN\s+[A-Z ]*PRIVATE KEY-----)/i;

export function createUnavailableBrowserSession(
  reason = "Browser sessions are unavailable from this build."
): BrowserSessionState {
  return {
    id: "browser-session-unavailable",
    source: "live",
    lifecycle: "unavailable",
    connectorIds: [],
    reason,
    fixtureOnly: false
  };
}

export function createFixtureBrowserSession(
  now = new Date(),
  connectorIds: readonly FirstWaveConnectorId[] = FIRST_WAVE_CONNECTOR_IDS
): BrowserSessionState {
  const startedAt = now.toISOString();
  return {
    id: `fixture-preview-${now.getTime()}`,
    source: "fixture-preview",
    lifecycle: "active",
    connectorIds: [...connectorIds],
    startedAt,
    expiresAt: new Date(now.getTime() + FIXTURE_SESSION_TTL_MS).toISOString(),
    reason: "Explicit preview session using fixture data only.",
    fixtureOnly: true
  };
}

export function deriveBrowserSessionFromConnectors(
  manifests: readonly ConnectorManifest[],
  now = new Date()
): BrowserSessionState {
  const firstWave = manifests.filter((manifest) =>
    (FIRST_WAVE_CONNECTOR_IDS as readonly string[]).includes(manifest.id)
  );
  const connected = firstWave.filter((manifest) => manifest.status === "connected");
  if (connected.length > 0) {
    return {
      id: `live-session-${now.getTime()}`,
      source: "live",
      lifecycle: "active",
      connectorIds: connected.map((manifest) => manifest.id),
      startedAt: now.toISOString(),
      reason: "Live desktop connector session.",
      fixtureOnly: false
    };
  }
  const expired = firstWave.find((manifest) => manifest.status === "expired" || manifest.status === "revoked");
  if (expired) {
    return {
      id: `live-session-${expired.id}-closed`,
      source: "live",
      lifecycle: "expired",
      connectorIds: [expired.id],
      closedAt: now.toISOString(),
      reason: `${expired.name} sign-in is expired or closed.`,
      fixtureOnly: false
    };
  }
  const failed = firstWave.find((manifest) => manifest.status === "provider-error" || manifest.status === "error");
  if (failed) {
    return {
      id: `live-session-${failed.id}-failed`,
      source: "live",
      lifecycle: "failed",
      connectorIds: [failed.id],
      failedAt: now.toISOString(),
      reason: `${failed.name} session failed.`,
      fixtureOnly: false
    };
  }
  const starting = firstWave.find((manifest) => manifest.status === "configured");
  if (starting) {
    return {
      id: `live-session-${starting.id}-starting`,
      source: "live",
      lifecycle: "starting",
      connectorIds: [starting.id],
      startedAt: now.toISOString(),
      reason: `${starting.name} is configured but not active yet.`,
      fixtureOnly: false
    };
  }
  return createUnavailableBrowserSession("No active browser or connector session is available.");
}

export function assertBrowserSessionMetadataSafe(session: BrowserSessionState): void {
  const inspect = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${path}.${index}`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          throw new Error(`Browser session metadata contains prohibited field "${path}.${key}".`);
        }
        inspect(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
      throw new Error(`Browser session metadata contains a secret-shaped value at "${path}".`);
    }
  };
  inspect(session, "session");
}

export function canUseBrowserSession(
  session: BrowserSessionState,
  connectorId: FirstWaveConnectorId,
  options: { allowFixturePreview?: boolean } = {}
): { ok: true } | { ok: false; result: ConnectorActionResult } {
  assertBrowserSessionMetadataSafe(session);
  if (session.fixtureOnly && !options.allowFixturePreview) {
    return {
      ok: false,
      result: unavailableResult(connectorId, "fixture-preview", "Fixture preview is disabled for this action.")
    };
  }
  if (session.lifecycle !== "active") {
    return {
      ok: false,
      result: unavailableResult(connectorId, session.lifecycle, session.reason)
    };
  }
  if (!session.connectorIds.includes(connectorId)) {
    return {
      ok: false,
      result: unavailableResult(connectorId, "unavailable", "This connector is not available in the active session.")
    };
  }
  return { ok: true };
}

export function labelFixtureSearchResult(result: ConnectorSearchResult): ConnectorSearchResult {
  return {
    ...result,
    source: "fixture",
    items: result.items.map((item) => ({
      ...item,
      summary: item.summary.startsWith("Preview data only:")
        ? item.summary
        : `Preview data only: ${item.summary}`,
      providerMetadata: {
        ...item.providerMetadata,
        fixtureOnly: "true"
      }
    }))
  };
}

export function resolveBrowserSessionAction(options: {
  session: BrowserSessionState;
  action: ConnectorActionRequest;
  decision: ApprovalDecision;
  permissionMode?: PermissionMode;
  allowFixturePreview?: boolean;
}): ConnectorActionResult {
  const { session, action, decision, permissionMode = action.permissionMode ?? "trusted-scope" } = options;
  const sessionGate = canUseBrowserSession(session, action.connectorId, {
    allowFixturePreview: options.allowFixturePreview
  });
  if (!sessionGate.ok) {
    return {
      ...sessionGate.result,
      requestId: action.id,
      action: action.action
    };
  }
  if (decision === "deny") {
    return {
      requestId: action.id,
      connectorId: action.connectorId,
      action: action.action,
      status: "denied",
      message: "The action was denied. Nothing ran."
    };
  }
  const policy = evaluatePermissionPolicy({
    mode: permissionMode,
    profile: action.permissionProfile,
    effect: effectForConnectorAction(action.action),
    riskLevel: action.approval.riskLevel
  });
  if (!policy.allowed) {
    return {
      requestId: action.id,
      connectorId: action.connectorId,
      action: action.action,
      status: "denied",
      message: policy.reason
    };
  }
  return {
    requestId: action.id,
    connectorId: action.connectorId,
    action: action.action,
    status: "completed",
    message: session.fixtureOnly
      ? "Preview action completed with fixture data only. No live provider changed."
      : "The approved connector action completed."
  };
}

function unavailableResult(
  connectorId: FirstWaveConnectorId,
  action: string,
  message: string
): ConnectorActionResult {
  return {
    requestId: `unavailable-${connectorId}`,
    connectorId,
    action: action as ConnectorActionResult["action"],
    status: "unavailable",
    message
  };
}
