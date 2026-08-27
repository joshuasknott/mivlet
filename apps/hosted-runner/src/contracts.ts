import type {
  HostedAgentRoutineCapability,
  HostedAgentRoutineRequest,
  HostedBrowserActionRequest,
  HostedBrowserNavigateRequest,
  HostedProcessLaunchRequest,
  HostedProcessScheduleRequest
} from "@fable/protocol";

const COMPUTER_ID = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const OBSERVATION_ID = /^observation-[A-Za-z0-9_-]{16,80}$/;
const ELEMENT_REF = /^control-[A-Za-z0-9_-]{16,80}-[0-9]{1,2}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const MAX_ARGV_ITEMS = 128;
const MAX_ARG_LENGTH = 16_384;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MIN_SCHEDULE_DELAY_MS = 10_000;
const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60_000;
const MIN_SCHEDULE_INTERVAL_SECONDS = 5 * 60;
const MAX_SCHEDULE_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

export class HostedRunnerRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "HostedRunnerRequestError";
  }
}

export function validateComputerId(value: string): string {
  if (!COMPUTER_ID.test(value)) {
    throw new HostedRunnerRequestError("The computer id is invalid.", "invalid-computer-id");
  }
  return value;
}

export function validateProcessId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/.test(value)) {
    throw new HostedRunnerRequestError("The process id is invalid.", "invalid-process-id");
  }
  return value;
}

export function validateScheduleId(value: string): string {
  if (!/^schedule-[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/u.test(value)) {
    throw new HostedRunnerRequestError("The schedule id is invalid.", "invalid-schedule-id");
  }
  return value;
}

export function validateRoutineId(value: string): string {
  if (!/^routine-[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/u.test(value)) {
    throw new HostedRunnerRequestError("The routine id is invalid.", "invalid-routine-id");
  }
  return value;
}

export function validateAgentRoutineRequest(value: unknown, now = Date.now()): HostedAgentRoutineRequest {
  if (!isRecord(value)) {
    throw new HostedRunnerRequestError("The hosted agent routine is invalid.", "invalid-agent-routine");
  }
  if (typeof value.requestKey !== "string" || !REQUEST_KEY.test(value.requestKey)) {
    throw new HostedRunnerRequestError("The request key is invalid.", "invalid-request-key");
  }
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) {
    throw new HostedRunnerRequestError("The run id is invalid.", "invalid-run-id");
  }
  const routineId = validateRoutineId(typeof value.routineId === "string" ? value.routineId : "");
  const title = validateBoundedText(value.title, 1, 120, "The routine title is invalid.");
  const instruction = validateBoundedText(value.instruction, 1, 12_000, "The routine instruction is invalid.");
  const firstRunAt = validateFutureScheduleTime(value.firstRunAt, now);
  const intervalSeconds = validateScheduleInterval(value.intervalSeconds);
  const capabilities = validateAgentRoutineCapabilities(value.capabilities);
  if (!Number.isInteger(value.maxSteps) || Number(value.maxSteps) < 1 || Number(value.maxSteps) > 8) {
    throw new HostedRunnerRequestError("The routine step limit is invalid.", "invalid-agent-routine-steps");
  }
  return {
    requestKey: value.requestKey,
    routineId,
    runId: value.runId,
    title,
    instruction,
    firstRunAt,
    intervalSeconds,
    capabilities,
    maxSteps: Number(value.maxSteps)
  };
}

export function validateAgentRoutineCapabilities(value: unknown): HostedAgentRoutineCapability[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new HostedRunnerRequestError("The routine capabilities are invalid.", "invalid-agent-routine-capabilities");
  }
  const allowed = new Set<HostedAgentRoutineCapability>(["workspace-read", "workspace-write", "process-run"]);
  const normalized: HostedAgentRoutineCapability[] = [];
  for (const capability of value) {
    if (typeof capability !== "string" || !allowed.has(capability as HostedAgentRoutineCapability)) {
      throw new HostedRunnerRequestError("The routine capabilities are invalid.", "invalid-agent-routine-capabilities");
    }
    const typed = capability as HostedAgentRoutineCapability;
    if (!normalized.includes(typed)) normalized.push(typed);
  }
  if (!normalized.includes("workspace-read")) {
    throw new HostedRunnerRequestError("Hosted agent routines require workspace read access.", "invalid-agent-routine-capabilities");
  }
  return normalized;
}

function validateBoundedText(value: unknown, min: number, max: number, message: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < min || value.length > max || hasUnsafeTextControl(value)) {
    throw new HostedRunnerRequestError(message, "invalid-agent-routine");
  }
  return value;
}

export function validateBrowserNavigateRequest(value: unknown): HostedBrowserNavigateRequest {
  if (!isRecord(value)) {
    throw new HostedRunnerRequestError("The browser navigation request is invalid.", "invalid-browser-navigation");
  }
  if (typeof value.requestKey !== "string" || !REQUEST_KEY.test(value.requestKey)) {
    throw new HostedRunnerRequestError("The browser request key is invalid.", "invalid-request-key");
  }
  return { requestKey: value.requestKey, url: validatePublicHttpsUrl(value.url) };
}

export function validateBrowserActionRequest(value: unknown): HostedBrowserActionRequest {
  if (!isRecord(value)) {
    throw new HostedRunnerRequestError("The browser action request is invalid.", "invalid-browser-action");
  }
  if (typeof value.requestKey !== "string" || !REQUEST_KEY.test(value.requestKey)) {
    throw new HostedRunnerRequestError("The browser request key is invalid.", "invalid-request-key");
  }
  if (typeof value.observationId !== "string" || !OBSERVATION_ID.test(value.observationId)) {
    throw new HostedRunnerRequestError("The browser observation is invalid.", "invalid-browser-observation");
  }
  if (typeof value.elementRef !== "string" || !ELEMENT_REF.test(value.elementRef)) {
    throw new HostedRunnerRequestError("The browser control reference is invalid.", "invalid-browser-control");
  }
  if (
    typeof value.controlRole !== "string"
    || !value.controlRole.trim()
    || value.controlRole.length > 40
    || hasUnsafeTextControl(value.controlRole)
    || typeof value.controlName !== "string"
    || !value.controlName.trim()
    || value.controlName.length > 160
    || hasUnsafeTextControl(value.controlName)
  ) {
    throw new HostedRunnerRequestError("The browser control description is invalid.", "invalid-browser-control");
  }
  if (value.action !== "click" && value.action !== "fill" && value.action !== "press" && value.action !== "select" && value.action !== "scroll" && value.action !== "history" && value.action !== "download") {
    throw new HostedRunnerRequestError("The browser action is not supported.", "invalid-browser-action");
  }
  const base = {
    requestKey: value.requestKey,
    observationId: value.observationId,
    elementRef: value.elementRef,
    controlRole: value.controlRole,
    controlName: value.controlName,
    action: value.action
  } as const;
  if (value.action === "fill" || value.action === "select") {
    if (typeof value.value !== "string" || value.value.length > 2_000 || hasUnsafeTextControl(value.value)) {
      throw new HostedRunnerRequestError(`The browser ${value.action} value is invalid.`, "invalid-browser-fill");
    }
    if (value.key !== undefined) {
      throw new HostedRunnerRequestError("The browser fill request has unexpected input.", "invalid-browser-action");
    }
    return { ...base, value: value.value };
  }
  if (value.action === "scroll") {
    if (
      value.elementRef !== `${value.observationId.replace("observation-", "control-")}-0`
      || value.controlRole !== "document"
      || value.controlName !== "Page"
      || typeof value.value !== "string"
      || !["half-page-up", "half-page-down", "page-up", "page-down"].includes(value.value)
      || value.key !== undefined
    ) {
      throw new HostedRunnerRequestError("The browser scroll request is invalid.", "invalid-browser-scroll");
    }
    return { ...base, value: value.value };
  }
  if (value.action === "history") {
    if (
      value.elementRef !== `${value.observationId.replace("observation-", "control-")}-0`
      || value.controlRole !== "document"
      || value.controlName !== "Page"
      || (value.value !== "back" && value.value !== "forward")
      || value.key !== undefined
    ) {
      throw new HostedRunnerRequestError("The browser history request is invalid.", "invalid-browser-history");
    }
    return { ...base, value: value.value };
  }
  if (value.action === "press") {
    if (typeof value.key !== "string" || !["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(value.key)) {
      throw new HostedRunnerRequestError("The browser key is not supported.", "invalid-browser-key");
    }
    if (value.value !== undefined) {
      throw new HostedRunnerRequestError("The browser key request has unexpected input.", "invalid-browser-action");
    }
    return { ...base, key: value.key };
  }
  if (value.value !== undefined || value.key !== undefined) {
    throw new HostedRunnerRequestError("The browser action has unexpected input.", "invalid-browser-action");
  }
  return base;
}

export function validatePublicHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()) {
    throw new HostedRunnerRequestError("The browser URL is invalid.", "invalid-browser-url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedRunnerRequestError("The browser URL is invalid.", "invalid-browser-url");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !hostname.includes(".")
    || isPrivateHostname(hostname)
  ) {
    throw new HostedRunnerRequestError("Only public HTTPS browser URLs are allowed.", "browser-url-not-public");
  }
  url.hostname = hostname;
  url.hash = "";
  return url.toString();
}

export function validateLaunchRequest(value: unknown): HostedProcessLaunchRequest {
  if (!isRecord(value)) {
    throw new HostedRunnerRequestError("The launch request is invalid.", "invalid-launch");
  }
  const requestKey = value.requestKey;
  const runId = value.runId;
  const argv = value.argv;
  const cwd = value.cwd;
  const timeoutMs = value.timeoutMs;
  if (typeof requestKey !== "string" || !REQUEST_KEY.test(requestKey)) {
    throw new HostedRunnerRequestError("The request key is invalid.", "invalid-request-key");
  }
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new HostedRunnerRequestError("The run id is invalid.", "invalid-run-id");
  }
  if (
    !Array.isArray(argv)
    || argv.length < 1
    || argv.length > MAX_ARGV_ITEMS
    || argv.some((arg) => typeof arg !== "string" || !arg || arg.length > MAX_ARG_LENGTH || arg.includes("\u0000"))
  ) {
    throw new HostedRunnerRequestError("The command argument list is invalid.", "invalid-argv");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || !isWorkspacePath(cwd))) {
    throw new HostedRunnerRequestError("The working directory must stay below /workspace.", "invalid-cwd");
  }
  if (
    timeoutMs !== undefined
    && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new HostedRunnerRequestError("The process timeout is outside the allowed range.", "invalid-timeout");
  }
  return {
    requestKey,
    runId,
    argv: argv as [string, ...string[]],
    ...(cwd === undefined ? {} : { cwd }),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {})
  };
}

export function validateProcessScheduleRequest(
  value: unknown,
  now = Date.now()
): HostedProcessScheduleRequest {
  if (!isRecord(value)) {
    throw new HostedRunnerRequestError("The process schedule is invalid.", "invalid-schedule");
  }
  const launch = validateLaunchRequest(value);
  const scheduleId = typeof value.scheduleId === "string" ? validateScheduleId(value.scheduleId) : null;
  let firstRunAt: string;
  let intervalSeconds: number;
  try {
    firstRunAt = validateFutureScheduleTime(value.firstRunAt, now);
    intervalSeconds = validateScheduleInterval(value.intervalSeconds);
  } catch {
    throw new HostedRunnerRequestError(
      "The process schedule timing is outside the allowed range.",
      "invalid-schedule"
    );
  }
  if (
    !scheduleId
    || launch.runId.length > 100
  ) {
    throw new HostedRunnerRequestError(
      "The process schedule timing is outside the allowed range.",
      "invalid-schedule"
    );
  }
  return {
    ...launch,
    scheduleId,
    firstRunAt,
    intervalSeconds
  };
}

function validateFutureScheduleTime(value: unknown, now: number): string {
  const parsed = typeof value === "string" ? new Date(value) : null;
  const milliseconds = parsed?.getTime() ?? Number.NaN;
  if (
    !parsed
    || !Number.isFinite(milliseconds)
    || parsed.toISOString() !== value
    || milliseconds < now + MIN_SCHEDULE_DELAY_MS
    || milliseconds > now + MAX_SCHEDULE_DELAY_MS
  ) {
    throw new HostedRunnerRequestError("The schedule time is outside the allowed range.", "invalid-schedule");
  }
  return parsed.toISOString();
}

function validateScheduleInterval(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_SCHEDULE_INTERVAL_SECONDS
    || value > MAX_SCHEDULE_INTERVAL_SECONDS
  ) {
    throw new HostedRunnerRequestError("The schedule interval is outside the allowed range.", "invalid-schedule");
  }
  return value;
}

function isWorkspacePath(value: string): boolean {
  if (value !== value.trim() || value.includes("\u0000") || value.includes("\\")) return false;
  if (value === "/workspace") return true;
  if (!value.startsWith("/workspace/")) return false;
  return !value.split("/").some((part) => part === ".." || part === ".");
}

function hasUnsafeTextControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") || code === 127;
  });
}

function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) {
    const octets = hostname.split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
    return octets[0] === 10
      || octets[0] === 127
      || octets[0] === 0
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] >= 224;
  }
  return hostname.includes(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
