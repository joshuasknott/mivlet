import type {
  HostedBrowserActionRequest,
  HostedBrowserNavigateRequest,
  HostedProcessLaunchRequest
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
    || !hostname
    || isForbiddenHostname(hostname)
    || isForbiddenAddress(hostnameIp(hostname))
  ) {
    throw new HostedRunnerRequestError("Only public HTTPS browser URLs are allowed.", "browser-url-not-public");
  }
  url.hostname = hostname;
  url.hash = "";
  return url.toString();
}

export type PublicAddressLookup = (hostname: string) => Promise<readonly string[]>;

let lookupPublicAddresses: PublicAddressLookup = lookupAddressesWithNodeDns;

/** Test-only DNS injection so encoded-IP and rebinding cases stay hermetic. */
export function setPublicAddressLookupForTests(lookup?: PublicAddressLookup): void {
  lookupPublicAddresses = lookup ?? lookupAddressesWithNodeDns;
}

/**
 * Resolve the hostname and refuse the URL when any answer is a private,
 * loopback, link-local, multicast, unspecified, or cloud-metadata address.
 * Mirrors desktop web-fetch: check literals first, then pin the DNS answer set.
 */
export async function assertPublicHttpsUrl(value: unknown): Promise<string> {
  const href = validatePublicHttpsUrl(value);
  const hostname = new URL(href).hostname;
  if (hostnameIp(hostname)) return href;
  let addresses: readonly string[];
  try {
    addresses = await lookupPublicAddresses(hostname);
  } catch {
    throw new HostedRunnerRequestError("The browser URL could not be resolved.", "browser-url-not-public");
  }
  if (!addresses.length || addresses.some((address) => isForbiddenAddress(address))) {
    throw new HostedRunnerRequestError("Only public HTTPS browser URLs are allowed.", "browser-url-not-public");
  }
  return href;
}

async function lookupAddressesWithNodeDns(hostname: string): Promise<string[]> {
  const dns = await import("node:dns/promises");
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
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

function isForbiddenHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }
  // Public hostnames must contain a dot. IP literals are checked separately.
  return !hostname.includes(".") && hostnameIp(hostname) === null;
}

function hostnameIp(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIPv4(host) || isIPv6(host)) return host;
  return null;
}

function isForbiddenAddress(address: string | null): boolean {
  if (!address) return false;
  const mapped = ipv4MappedAddress(address);
  if (mapped) return isForbiddenIPv4(mapped);
  if (isIPv4(address)) return isForbiddenIPv4(address);
  if (isIPv6(address)) return isForbiddenIPv6(address);
  return true;
}

function isIPv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
    && value.split(".").every((octet) => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === octet;
    });
}

function isIPv6(value: string): boolean {
  return value.includes(":") && !value.includes("%");
}

function ipv4MappedAddress(address: string): string | null {
  const match = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (match) return isIPv4(match[1]) ? match[1] : null;
  const hex = address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function isForbiddenIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
    || (a === 192 && b === 0 && octets[2] === 2)
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && octets[2] === 0)
    || (a === 100 && b === 100 && octets[2] === 100 && octets[3] === 200);
}

function isForbiddenIPv6(address: string): boolean {
  const compact = address.toLowerCase();
  if (compact === "::" || compact === "::1") return true;
  const segments = expandIPv6(compact);
  if (!segments) return true;
  const first = segments[0];
  const loopback = segments.every((segment, index) => (index === 7 ? segment === 1 : segment === 0));
  const unspecified = segments.every((segment) => segment === 0);
  return loopback
    || unspecified
    || (first & 0xffc0) === 0xfe80
    || (first & 0xfe00) === 0xfc00
    || (first & 0xff00) === 0xff00;
}

function expandIPv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((segment) => Number.parseInt(segment, 16)) : []);
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 0xffff)
    || tail.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 0xffff)) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
