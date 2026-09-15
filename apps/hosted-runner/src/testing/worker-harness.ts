/**
 * In-memory hosted-runner fetch harness.
 *
 * Drives `src/index.ts` with fake Computer/Browser Durable Object stores.
 * No live Cloudflare Sandbox, Browser Run, or Playwright.
 */
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import {
  signHostedExecutionCapability,
  type HostedBrowserSnapshot,
  type HostedComputerSnapshot,
  type HostedExecutionCapabilityPayload,
  type HostedExecutionCapabilityScope,
  type HostedProcessLaunchRequest,
  type HostedProcessSnapshot
} from "@mivlet/protocol";
import worker from "../index";
import type { CapabilityNonceStore } from "../request-auth";

const HOSTED_RUNNER_COMPUTER_ID = "computer-workspace-agent";
const HOSTED_RUNNER_SIGNING_KEY = "runner-signing-secret-with-at-least-thirty-two-ch";
const HOSTED_RUNNER_SERVICE_KEY = "runner-service-secret-with-at-least-thirty-two-ch";
const HOSTED_RUNNER_BASE_URL = "https://runner.example";

const FIXED_UPDATED_AT = "2026-08-24T16:00:00.000Z";

installWorkerCryptoPolyfill();

export class MemoryNonceStore implements CapabilityNonceStore {
  readonly consumed = new Set<string>();

  async consume(input: { nonce: string; generation: number; expiresAt: number }): Promise<void> {
    if (this.consumed.has(input.nonce)) {
      throw operationError("capability-replayed");
    }
    this.consumed.add(input.nonce);
  }
}

class FakeComputerAuthority {
  lifecycle: HostedComputerSnapshot["lifecycle"] = "ready";
  keepAlive = true;
  readonly consumedNonces = new Set<string>();
  readonly launches: HostedProcessLaunchRequest[] = [];
  readonly inspects: string[] = [];
  readonly kills: string[] = [];
  readonly readyChecks: number[] = [];
  ensureCalls = 0;
  statusCalls = 0;
  destroyCalls = 0;

  constructor(
    readonly computerId: string,
    public generation: number
  ) {}

  async consumeCapabilityNonce(
    _computerId: string,
    nonce: string,
    expectedGeneration: number,
    _expiresAt: number
  ): Promise<void> {
    this.fence(expectedGeneration);
    if (this.consumedNonces.has(nonce)) throw operationError("capability-replayed");
    this.consumedNonces.add(nonce);
  }

  async requireReady(_computerId: string, expectedGeneration: number): Promise<number> {
    this.fence(expectedGeneration);
    this.readyChecks.push(expectedGeneration);
    return this.generation;
  }

  async ensure(computerId: string): Promise<HostedComputerSnapshot> {
    this.ensureCalls += 1;
    this.computerIdSatisfied(computerId);
    return this.snapshot();
  }

  async status(computerId: string): Promise<HostedComputerSnapshot> {
    this.statusCalls += 1;
    this.computerIdSatisfied(computerId);
    return this.snapshot();
  }

  async destroy(computerId: string): Promise<HostedComputerSnapshot> {
    this.destroyCalls += 1;
    this.computerIdSatisfied(computerId);
    this.lifecycle = "destroyed";
    this.keepAlive = false;
    this.generation += 1;
    return this.snapshot();
  }

  async launch(
    computerId: string,
    request: HostedProcessLaunchRequest,
    expectedGeneration: number
  ): Promise<HostedProcessSnapshot> {
    this.computerIdSatisfied(computerId);
    this.fence(expectedGeneration);
    this.launches.push(request);
    return {
      requestKey: request.requestKey,
      runId: request.runId,
      lifecycle: "running",
      processId: "proc-test-1"
    };
  }

  async inspect(
    computerId: string,
    processId: string,
    expectedGeneration: number
  ): Promise<HostedProcessSnapshot> {
    this.computerIdSatisfied(computerId);
    this.fence(expectedGeneration);
    this.inspects.push(processId);
    return {
      requestKey: "request:run-123:1",
      runId: "run-123",
      lifecycle: "running",
      processId
    };
  }

  async kill(
    computerId: string,
    processId: string,
    expectedGeneration: number
  ): Promise<HostedProcessSnapshot> {
    this.computerIdSatisfied(computerId);
    this.fence(expectedGeneration);
    this.kills.push(processId);
    return {
      requestKey: "request:run-123:1",
      runId: "run-123",
      lifecycle: "cancelling",
      processId
    };
  }

  snapshot(): HostedComputerSnapshot {
    return {
      computerId: this.computerId,
      lifecycle: this.lifecycle,
      runtimeActive: this.lifecycle === "ready",
      keepAlive: this.keepAlive,
      generation: this.generation,
      updatedAt: FIXED_UPDATED_AT
    };
  }

  private fence(expectedGeneration: number): void {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw operationError("capability-stale");
    }
    if (this.lifecycle !== "ready" || !this.keepAlive || this.generation !== expectedGeneration) {
      throw operationError("capability-stale");
    }
  }

  private computerIdSatisfied(computerId: string): void {
    if (computerId !== this.computerId) throw operationError("computer-not-found");
  }
}

class FakeBrowserAuthority {
  readonly navigates: Array<{ request: unknown; generation: number }> = [];
  readonly acts: Array<{ request: unknown; generation: number }> = [];
  readonly snapshots: number[] = [];
  destroyCalls = 0;

  async navigate(
    _computerId: string,
    request: unknown,
    generation: number
  ): Promise<HostedBrowserSnapshot> {
    this.navigates.push({ request, generation });
    return hostedBrowserSnapshot();
  }

  async act(
    _computerId: string,
    request: unknown,
    generation: number
  ): Promise<HostedBrowserSnapshot> {
    this.acts.push({ request, generation });
    return hostedBrowserSnapshot();
  }

  async snapshot(_computerId: string, generation: number): Promise<HostedBrowserSnapshot> {
    this.snapshots.push(generation);
    return hostedBrowserSnapshot();
  }

  async destroy(_computerId: string): Promise<void> {
    this.destroyCalls += 1;
  }
}

interface HostedRunnerHarness {
  readonly computerId: string;
  readonly signingKey: string;
  readonly serviceKey: string;
  readonly computer: FakeComputerAuthority;
  readonly browser: FakeBrowserAuthority;
  fetch(request: Request): Promise<Response>;
  signCapability(
    overrides?: Partial<HostedExecutionCapabilityPayload>
  ): Promise<string>;
  capabilityHeaders(token: string): HeadersInit;
  serviceHeaders(): HeadersInit;
  processLaunchRequest(token: string): Request;
  browserNavigateRequest(token: string): Request;
  browserSnapshotRequest(token: string): Request;
}

export function createHostedRunnerHarness(
  options: { generation?: number; computerId?: string } = {}
): HostedRunnerHarness {
  const computerId = options.computerId ?? HOSTED_RUNNER_COMPUTER_ID;
  const generation = options.generation ?? 3;
  const computer = new FakeComputerAuthority(computerId, generation);
  const browser = new FakeBrowserAuthority();
  let nonceSeq = 0;

  const env = {
    MIVLET_HOSTED_RUNNER_API_KEY: HOSTED_RUNNER_SERVICE_KEY,
    MIVLET_HOSTED_RUNNER_SIGNING_KEY: HOSTED_RUNNER_SIGNING_KEY,
    COMPUTER_AUTHORITY: { getByName: () => computer },
    BROWSER_AUTHORITY: { getByName: () => browser },
    MYBROWSER: {},
    Sandbox: {}
  } as unknown as Env;

  async function signCapability(
    overrides: Partial<HostedExecutionCapabilityPayload> = {}
  ): Promise<string> {
    nonceSeq += 1;
    const issuedAt = Date.now();
    return signHostedExecutionCapability(HOSTED_RUNNER_SIGNING_KEY, {
      version: 1,
      computerId,
      generation,
      scopes: ["process:launch", "process:inspect", "process:kill"],
      issuedAt,
      expiresAt: issuedAt + 120_000,
      nonce: `capability-nonce-${nonceSeq}`,
      ...overrides
    });
  }

  return {
    computerId,
    signingKey: HOSTED_RUNNER_SIGNING_KEY,
    serviceKey: HOSTED_RUNNER_SERVICE_KEY,
    computer,
    browser,
    async fetch(request: Request): Promise<Response> {
      const log = console.log;
      const error = console.error;
      console.log = () => undefined;
      console.error = () => undefined;
      try {
        return await worker.fetch(request, env);
      } finally {
        console.log = log;
        console.error = error;
      }
    },
    signCapability,
    capabilityHeaders(token: string): HeadersInit {
      return { Authorization: `MivletCapability ${token}` };
    },
    serviceHeaders(): HeadersInit {
      return { Authorization: `Bearer ${HOSTED_RUNNER_SERVICE_KEY}` };
    },
    processLaunchRequest(token: string): Request {
      return jsonRequest(
        "POST",
        `/v1/computers/${computerId}/processes`,
        { Authorization: `MivletCapability ${token}` },
        {
          requestKey: "request:run-123:1",
          runId: "run-123",
          argv: ["node", "--version"]
        }
      );
    },
    browserNavigateRequest(token: string): Request {
      return jsonRequest(
        "POST",
        `/v1/computers/${computerId}/browser/navigate`,
        { Authorization: `MivletCapability ${token}` },
        {
          requestKey: "browser:request-123",
          url: "https://example.com/path"
        }
      );
    },
    browserSnapshotRequest(token: string): Request {
      return new Request(
        `${HOSTED_RUNNER_BASE_URL}/v1/computers/${computerId}/browser/snapshot`,
        { headers: { Authorization: `MivletCapability ${token}` } }
      );
    }
  };
}

export function jsonRequest(
  method: string,
  path: string,
  headers: HeadersInit,
  body?: unknown
): Request {
  return new Request(`${HOSTED_RUNNER_BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function hostedBrowserSnapshot(): HostedBrowserSnapshot {
  return {
    currentUrl: "https://example.com/",
    title: "Example",
    observationId: "observation-1234567890abcdef",
    viewport: {
      scrollX: 0,
      scrollY: 0,
      width: 1280,
      height: 800,
      documentWidth: 1280,
      documentHeight: 800,
      canScrollUp: false,
      canScrollDown: false
    },
    navigation: { canGoBack: false, canGoForward: false },
    controls: [],
    previewDataUrl: "data:image/png;base64,AA==",
    updatedAt: FIXED_UPDATED_AT
  };
}

export const PROCESS_SCOPES: HostedExecutionCapabilityScope[] = [
  "process:launch",
  "process:inspect",
  "process:kill"
];

export const BROWSER_SCOPES: HostedExecutionCapabilityScope[] = [
  "browser:navigate",
  "browser:act",
  "browser:snapshot"
];

function operationError(code: string): Error {
  const error = new Error(code);
  error.name = "HostedComputerOperationError";
  return error;
}

function installWorkerCryptoPolyfill(): void {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return;
  Object.defineProperty(subtle, "timingSafeEqual", {
    configurable: true,
    value(a: BufferSource, b: BufferSource): boolean {
      const left = bufferSource(a);
      const right = bufferSource(b);
      if (left.length !== right.length) return false;
      return nodeTimingSafeEqual(left, right);
    }
  });
}

function bufferSource(source: BufferSource): Buffer {
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}
