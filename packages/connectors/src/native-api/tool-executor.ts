/**
 * Real tool execution behind Mivlet's approval layer.
 *
 * The executor is the concrete implementation of the four registered tools
 * (read-file, write-file, run-shell, web-fetch, local-app-observe/action, cloud-browser). It is pure over an injectable
 * {@link ToolRuntime} — every filesystem/shell/network capability flows through
 * that seam, so production wires it to Tauri commands (Rust owns the actual
 * side effects) and tests inject a fake filesystem. Tools never spawn a shell
 * or write files from JavaScript directly.
 *
 * CRITICAL SAFETY INVARIANT: the executor never runs until its {@link ApprovalGate}
 * reports a grant for the call. A tool-call's {@link ApprovalRequest} must be
 * surfaced to the user first; only once/session/rule grants (never `deny`) let
 * the executor proceed. The agent loop calls the executor synchronously per
 * tool-call event, but the approval decision is asynchronous — the gate blocks
 * the executor until the shell resolves it (or auto-satisfies it from a standing
 * session/rule grant).
 *
 * Fail-closed everywhere: an unknown tool, a missing argument, a non-zero shell
 * exit, or a denied grant all reject (the loop turns the rejection into a
 * tool-role error message and continues).
 */

import type { ApprovalGrant, ApprovalRequest, PermissionMode } from "@fable/protocol";
import { lookupTool } from "./tools";
import type { ToolExecutor } from "./agent-loop";
import { effectForTool, evaluatePermissionPolicy } from "../permission-policy";

/** The outcome of an approval gate check for a tool call. */
export type DecisionResult = "granted" | "denied";

/**
 * The capability seam: each method performs one tool's side effect. Production
 * wires this to Tauri commands (Rust owns fs/shell/network); tests inject a
 * fake. Returning `null` from readFile / fetchUrl signals "not found" so the
 * executor can reject with a clear error rather than empty output.
 */
export interface ToolRuntime {
  /** Read a workspace text file. Returns null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Write/overwrite a workspace file. Returns the number of bytes written. */
  writeFile(path: string, content: string): Promise<number>;
  /** Run a command only when an isolated hosted runtime is explicitly supplied. */
  runShell(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Fetch a URL and return its text. Returns null on a fetch failure. */
  fetchUrl(url: string): Promise<string | null>;
  /** Open a page in a hosted browser when the runtime supplies that capability. */
  openBrowser?(url: string): Promise<string>;
  /** Optional native Windows boundary; the desktop supplies its own exact approval executor. */
  listAppWindows?(): Promise<string>;
  selectAppWindow?(windowId: string, deliveryMode?: import("@fable/protocol").NativeComputerDeliveryMode): Promise<string>;
  observeApp?(): Promise<string>;
  actApp?(input: import("@fable/protocol").NativeAppAction): Promise<string>;
  /** Act on one opaque control ref from the latest hosted-browser observation. */
  actBrowser?(input: {
    action: "click" | "fill" | "press" | "select" | "scroll" | "history";
    observationId: string;
    elementRef: string;
    controlRole: string;
    controlName: string;
    value?: string;
    key?: string;
  }): Promise<string>;
  /** Execute an authenticated Google read without exposing credentials to JS. */
  googleRead?(tool: string, input: Record<string, unknown>): Promise<string>;
  /** Run one approved direct-OpenAI image generation through the native boundary. */
  generateImage?(input: ImageToolInput): Promise<string>;
  /** Run one approved direct-OpenAI edit of an immutable image artifact. */
  editImage?(input: ImageToolInput & { sourceArtifactId: string }): Promise<string>;
}

export interface ImageToolInput {
  prompt: string;
  model: "gpt-image-2";
  size: "1024x1024" | "1536x1024" | "1024x1536";
  quality: "low" | "medium" | "high";
  title: string;
}

/**
 * The approval gate the executor awaits. The shell implements this: it blocks
 * a tool call's executor until the user grants (once/session/rule) or denies,
 * or auto-satisfies the call immediately when a standing grant already covers
 * it. `register` lets the shell pre-create a pending entry when the tool-call
 * event arrives, so a grant that races the executor still resolves it.
 */
export interface ApprovalGate {
  /**
   * Resolve the approval decision for a tool call. Returns immediately with
   * "granted" when a standing grant covers it; otherwise blocks until the shell
   * resolves the pending call (grant → "granted", deny → "denied").
   */
  waitForDecision(approval: ApprovalRequest): Promise<DecisionResult>;
}

/**
 * The shell's side of the gate: the dispatch methods that drive pending tool
 * calls and manage standing grants. {@link ProductionApprovalGate} implements
 * this; the shell ({@link useShellRuntime}) requires it so a grant/deny in the
 * approval UI unblocks the tool call the agent loop is awaiting.
 */
export interface ToolApprovalGate extends ApprovalGate {
  /**
   * Register a pending tool call before the executor awaits. Returns true only
   * when the shell needs to surface a fresh approval; exact standing grants and
   * duplicate pending requests return false.
   */
  register(approval: ApprovalRequest): boolean;
  /** Drive a pending call to "granted" (the executor proceeds). */
  resolveGrant(approvalId: string): void;
  /** Drive a pending call to "denied" (the executor refuses). */
  resolveDeny(approvalId: string): void;
  /** True when a tool call with this approval id is awaiting a decision. */
  hasPending(approvalId: string): boolean;
  /** Replace the full set of standing (session/rule) grants. */
  replaceStandingGrants(grants: ApprovalGrant[]): void;
  /**
   * Tear down every pending entry. Called when the agent run is cancelled so a
   * cancelled-but-never-granted call (and its unresolved promise) does not
   * linger for the session. Each pending waiter is rejected.
   */
  cancelPending(): void;
}

/** Create a gate stub resolving every call to a fixed decision (test helper). */
export function createApprovalGate(): ProductionApprovalGate {
  return new ProductionApprovalGate();
}

/** Connected reads use their existing account consent; native scopes and exact
 * request validation still run. Unknown tools and consequential calls never qualify. */
export function isRoutineConnectorRead(approval: ApprovalRequest): boolean {
  const name = approval.action.split(/\s+/)[0];
  const tool = lookupTool(name);
  return Boolean(name !== "connection-read" && tool && effectForTool(name) === "connector-read"
    && tool.defaultMode === "read-only" && approval.mode === "read-only"
    && tool.defaultRisk === approval.riskLevel
    && (approval.riskLevel === "low" || approval.riskLevel === "medium"));
}

/**
 * The production gate: tracks standing (session/rule) grants and pending calls.
 * Legacy standing grants may auto-satisfy matching low-risk calls. High-risk
 * calls always wait for a fresh decision.
 *
 * Concurrency model: a pending call is a deferred — an { resolve } pair held in
 * the pending map keyed by approval id. `register` pre-creates the entry (so a
 * grant that arrives before the executor awaits still resolves it); the entry's
 * promise is created lazily on `waitForDecision` and driven by `resolveGrant` /
 * `resolveDeny`. Resolutions that arrive before a waiter (the register-then-
 * resolve race) are cached in `settled` and replayed by the next await.
 */
export class ProductionApprovalGate implements ApprovalGate {
  private readonly standingGrants: ApprovalGrant[] = [];
  /** Pending calls: approval id -> deferred. */
  private readonly pending = new Map<string, PendingEntry>();
  /** Resolutions that arrived before a waiter, cached for the next await. */
  private readonly settled = new Map<string, DecisionResult>();

  /** Add a standing grant (session or rule) used to auto-satisfy matching calls. */
  addStandingGrant(grant: ApprovalGrant): void {
    this.standingGrants.push(grant);
  }

  /**
   * Replace the full set of standing grants. The shell re-syncs this whenever its
   * session/rule grants change so the gate reflects the current grant state
   * without accumulating duplicates.
   */
  replaceStandingGrants(grants: ApprovalGrant[]): void {
    this.standingGrants.length = 0;
    this.standingGrants.push(...grants);
  }

  /** Register a pending call (keyed by approval id) before the executor awaits. */
  register(approval: ApprovalRequest): boolean {
    if (isRoutineConnectorRead(approval)) return false;
    if (this.standingGrants.some((grant) => grantMatches(grant, approval))) {
      return false;
    }
    if (this.pending.has(approval.id)) return false;
    // Create a deferred with no resolver yet; waitForDecision wires the promise
    // (and adopts an early resolution from `settled` if one is waiting).
    this.pending.set(approval.id, { approval });
    return true;
  }

  /** Grant a pending call by approval id (drives its waiter to "granted"). */
  resolveGrant(approvalId: string): void {
    this.resolve(approvalId, "granted");
  }

  /** Deny a pending call by approval id (drives its waiter to "denied"). */
  resolveDeny(approvalId: string): void {
    this.resolve(approvalId, "denied");
  }

  /** Number of calls awaiting a decision (for diagnostics / tests). */
  pendingCount(): number {
    return this.pending.size;
  }

  /** True when a tool call with this approval id is awaiting a decision. */
  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /**
   * Tear down every pending entry. Called when the agent run is cancelled: each
   * pending waiter is rejected (so its executor refuses and the loop records a
   * tool-role error) and the pending + early-settled maps are cleared so a long
   * session never accumulates cancelled-but-never-granted calls or their
   * unresolved promises.
   */
  cancelPending(): void {
    for (const entry of this.pending.values()) {
      entry.reject?.(new Error("Tool call cancelled before it was granted."));
    }
    this.pending.clear();
    this.settled.clear();
  }

  async waitForDecision(approval: ApprovalRequest): Promise<DecisionResult> {
    if (isRoutineConnectorRead(approval)) return "granted";
    // A legacy standing grant can cover only an exact low-risk request.
    if (this.standingGrants.some((grant) => grantMatches(grant, approval))) {
      return "granted";
    }
    // An early resolution is replayed immediately (register-then-resolve race).
    const early = this.settled.get(approval.id);
    if (early !== undefined) {
      this.settled.delete(approval.id);
      this.pending.delete(approval.id);
      return early;
    }
    // Create the deferred's promise if not already present, then await its
    // resolver. resolveGrant/resolveDeny drive `entry.resolve` to settle it;
    // cancelPending drives `entry.reject` to tear it down.
    if (!this.pending.has(approval.id)) {
      this.register(approval);
    }
    const entry = this.pending.get(approval.id)!;
    if (!entry.promise) {
      entry.promise = new Promise<DecisionResult>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
    }
    const decision = await entry.promise;
    this.pending.delete(approval.id);
    return decision;
  }

  /** Drive a pending call (or cache the resolution for a later waiter). */
  private resolve(approvalId: string, decision: DecisionResult): void {
    const entry = this.pending.get(approvalId);
    if (entry?.resolve) {
      entry.resolve(decision);
      return;
    }
    // No waiter yet (register-then-resolve race): cache for the next await.
    this.settled.set(approvalId, decision);
  }
}

/** A pending tool call: the approval + its deferred promise/resolver. */
interface PendingEntry {
  approval: ApprovalRequest;
  promise?: Promise<DecisionResult>;
  resolve?: (decision: DecisionResult) => void;
  /** Driven by cancelPending to tear down a never-granted call. */
  reject?: (error: Error) => void;
}

/**
 * Does a legacy standing grant cover this approval? High/critical risk never
 * auto-matches. Every remaining field represented by ApprovalGrant must agree
 * exactly so argument substitution and mode changes fail closed.
 */
function grantMatches(grant: ApprovalGrant, approval: ApprovalRequest): boolean {
  // Semantic Connection reads use a separate durable capability grant. A
  // legacy session/rule approval must never become implicit standing source
  // authority or replace the exact-action approval for an individual search.
  if (approval.action.split(/\s+/)[0] === "connection-read") {
    return false;
  }
  if (approval.riskLevel === "high" || approval.riskLevel === "critical") {
    return false;
  }
  return (
    grant.service === approval.service &&
    grant.action === approval.action &&
    grant.mode === approval.mode &&
    grant.permissionProfile === approval.permissionProfile &&
    grant.dataUsed.length === approval.dataUsed.length &&
    grant.dataUsed.every((value, index) => value === approval.dataUsed[index])
  );
}

/** Options for {@link createToolExecutor}. */
export interface CreateToolExecutorOptions {
  /** The capability seam (fs/shell/network). Required. */
  runtime: ToolRuntime;
  /** The approval gate the executor awaits before running any tool. Required. */
  gate: ApprovalGate;
  /** Active permission profile for this executor. Defaults to full with approvals. */
  permissionMode?: PermissionMode;
}

/**
 * Create a {@link ToolExecutor} that runs the four registered tools behind the
 * approval gate. The returned function matches the agent loop's ToolExecutor
 * contract — it is called once per tool-call event with the call's approval and
 * raw arguments, and resolves to a tool-result string the loop appends.
 */
export function createToolExecutor(options: CreateToolExecutorOptions): ToolExecutor {
  const { runtime, gate, permissionMode = "full-access" } = options;
  return async (approval, args) => {
    const decision = await gate.waitForDecision(approval);
    if (decision !== "granted") {
      throw new Error(`Tool call denied: ${approval.action}.`);
    }
    return dispatch(approval, args, runtime, permissionMode);
  };
}

/** Dispatch a granted tool call to the matching runtime capability. */
async function dispatch(
  approval: ApprovalRequest,
  args: string,
  runtime: ToolRuntime,
  permissionMode: PermissionMode
): Promise<string> {
  // The tool name is the first whitespace-delimited token of the action, which
  // buildToolApproval shapes as "<tool-name> <args>". Registered tools dispatch
  // by name; anything else fails closed.
  const toolName = approval.action.split(/\s+/)[0];
  const tool = lookupTool(toolName);
  const effect = effectForTool(toolName);
  const policy = effect
    ? evaluatePermissionPolicy({
        mode: permissionMode,
        effect,
        riskLevel: approval.riskLevel
      })
    : null;
  if (!policy?.allowed) {
    throw new Error(
      `Permission denied: ${permissionMode} profile forbids ${toolName}. ${policy?.reason ?? "Unknown tool effect."}`
    );
  }
  if (!tool) {
    throw new Error(`Unknown tool "${toolName}" — not in Mivlet's tool registry.`);
  }
  const parsed = safeParseArgs(args);

  switch (toolName) {
    case "read-file": {
      const path = requireString(parsed, toolName, "path");
      const content = await runtime.readFile(path);
      if (content === null) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    }
    case "write-file": {
      const path = requireString(parsed, toolName, "path");
      const content = requireString(parsed, toolName, "content");
      const written = await runtime.writeFile(path, content);
      return `Wrote ${written} byte${written === 1 ? "" : "s"} to ${path}.`;
    }
    case "run-shell": {
      if (parsed.location !== "hosted") throw new Error("Shell execution requires an explicitly configured hosted computer.");
      const command = requireString(parsed, toolName, "command");
      const result = await runtime.runShell(command);
      if (result.exitCode !== 0) {
        throw new Error(
          `Shell command failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}`
        );
      }
      return result.stdout || `ran: ${command}`;
    }
    case "web-fetch": {
      const url = requireString(parsed, toolName, "url");
      const text = await runtime.fetchUrl(url);
      if (text === null) {
        throw new Error(`Fetch failed: ${url}`);
      }
      return text;
    }
    case "cloud-browser": {
      const url = requireString(parsed, toolName, "url");
      if (!runtime.openBrowser) {
        throw new Error("The cloud browser is unavailable in this runtime.");
      }
      return runtime.openBrowser(url);
    }
    case "local-app-list": {
      if (!runtime.listAppWindows) throw new Error("Native Windows discovery is unavailable in this runtime.");
      if (Object.keys(parsed).length) throw new Error("Application discovery takes no arguments.");
      return runtime.listAppWindows();
    }
    case "local-app-select": {
      if (!runtime.selectAppWindow) throw new Error("Native Windows selection is unavailable in this runtime.");
      if (Object.keys(parsed).some(key => !["windowId", "deliveryMode"].includes(key))) throw new Error("Application selection accepts only windowId and deliveryMode.");
      const deliveryMode = parsed.deliveryMode === undefined ? "background" : parsed.deliveryMode;
      if (deliveryMode !== "background" && deliveryMode !== "foreground") throw new Error("Application selection requires background or foreground deliveryMode.");
      return runtime.selectAppWindow(requireString(parsed, toolName, "windowId"), deliveryMode);
    }
    case "local-app-observe": {
      if (!runtime.observeApp) throw new Error("Native Windows observation is unavailable in this runtime.");
      if (Object.keys(parsed).length) throw new Error("Application observation takes no arguments.");
      return runtime.observeApp();
    }
    case "local-app-action": {
      if (!runtime.actApp) throw new Error("Native Windows actions are unavailable in this runtime.");
      const action = requireString(parsed, toolName, "action");
      if (!["click", "type", "scroll", "key"].includes(action)) throw new Error("Unsupported Windows application action.");
      // Exact fields and native window authority are revalidated by the runtime.
      return runtime.actApp({ ...parsed, action: action as import("@fable/protocol").NativeAppAction["action"], observationId: requireString(parsed, toolName, "observationId") });
    }
    case "cloud-browser-action": {
      if (!runtime.actBrowser) {
        throw new Error("Cloud browser actions are unavailable in this runtime.");
      }
      const action = requireString(parsed, toolName, "action");
      if (action !== "click" && action !== "fill" && action !== "press" && action !== "select" && action !== "scroll" && action !== "history") {
        throw new Error("Tool cloud-browser-action requires click, fill, press, select, scroll, or history.");
      }
      const observationId = requireString(parsed, toolName, "observationId");
      const elementRef = requireString(parsed, toolName, "elementRef");
      const controlRole = requireString(parsed, toolName, "controlRole");
      const controlName = requireString(parsed, toolName, "controlName");
      return runtime.actBrowser({
        action,
        observationId,
        elementRef,
        controlRole,
        controlName,
        ...(typeof parsed.value === "string" ? { value: parsed.value } : {}),
        ...(typeof parsed.key === "string" ? { key: parsed.key } : {})
      });
    }
    case "google-drive-read":
    case "gmail-read":
    case "google-calendar-read": {
      if (!runtime.googleRead) {
        throw new Error(`Tool ${toolName} requires the native Google runtime.`);
      }
      return runtime.googleRead(toolName, parsed);
    }
    case "generate-image": {
      if (!runtime.generateImage) {
        throw new Error("Image generation requires the native OpenAI media runtime.");
      }
      return runtime.generateImage(requireImageInput(parsed, false));
    }
    case "edit-image": {
      if (!runtime.editImage) {
        throw new Error("Image editing requires the native OpenAI media runtime.");
      }
      return runtime.editImage(requireImageInput(parsed, true));
    }
    default:
      // A registered tool with no dispatcher is a programming error; fail closed.
      throw new Error(`Tool "${toolName}" has no executor implementation.`);
  }
}

function requireImageInput(
  parsed: Record<string, unknown>,
  editing: false
): ImageToolInput;
function requireImageInput(
  parsed: Record<string, unknown>,
  editing: true
): ImageToolInput & { sourceArtifactId: string };
function requireImageInput(
  parsed: Record<string, unknown>,
  editing: boolean
): ImageToolInput & { sourceArtifactId?: string } {
  const expected = editing
    ? ["model", "prompt", "quality", "size", "sourceArtifactId", "title"]
    : ["model", "prompt", "quality", "size", "title"];
  if (Object.keys(parsed).sort().join("\0") !== expected.join("\0")) {
    throw new Error(`Tool ${editing ? "edit-image" : "generate-image"} has missing or extra arguments.`);
  }
  const prompt = requireString(parsed, editing ? "edit-image" : "generate-image", "prompt");
  const title = requireString(parsed, editing ? "edit-image" : "generate-image", "title");
  const normalizedPrompt = prompt.trim().replace(/\s+/gu, " ");
  if (normalizedPrompt.length === 0 || [...normalizedPrompt].length > 220) {
    throw new Error("Image prompts must contain 1 to 220 visible characters.");
  }
  if (title.trim().length === 0 || [...title.trim()].length > 160) {
    throw new Error("Image titles must contain 1 to 160 characters.");
  }
  if (parsed.model !== "gpt-image-2") {
    throw new Error("Choose the documented gpt-image-2 image model explicitly.");
  }
  if (parsed.size !== "1024x1024" && parsed.size !== "1536x1024" && parsed.size !== "1024x1536") {
    throw new Error("Choose a supported image size.");
  }
  if (parsed.quality !== "low" && parsed.quality !== "medium" && parsed.quality !== "high") {
    throw new Error("Choose low, medium, or high image quality.");
  }
  const common: ImageToolInput = {
    prompt: normalizedPrompt,
    model: parsed.model,
    size: parsed.size,
    quality: parsed.quality,
    title: title.trim()
  };
  if (!editing) return common;
  const sourceArtifactId = requireString(parsed, "edit-image", "sourceArtifactId");
  if (!/^artifact-[0-9a-f]{64}$/.test(sourceArtifactId)) {
    throw new Error("Tool edit-image requires a verified Mivlet image artifact id.");
  }
  return { ...common, sourceArtifactId };
}

/** Parse a tool-call arguments JSON string into a record (empty on parse miss). */
function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Extract a required string argument, rejecting clearly when it is missing. */
function requireString(
  parsed: Record<string, unknown>,
  toolName: string,
  key: string
): string {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool ${toolName} requires a non-empty "${key}" argument.`);
  }
  return value;
}

/** The PermissionMode re-export keeps the gate's grant-matching contract explicit. */
export type { PermissionMode };
