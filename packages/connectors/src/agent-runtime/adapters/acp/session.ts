/** Drive one ACP v1 prompt turn over an injected stdio/JSON-RPC transport. */

import type { AgentTurnRequest, BackendAgentEvent } from "@fable/protocol";
import type { AgentTurnOptions } from "../../contract";
import {
  MAX_TOOL_ARGUMENT_CHARACTERS,
  MAX_TOOL_CALLS_PER_RUN,
  MAX_TOOL_OUTPUT_CHARACTERS
} from "../../../native-api/agent-loop";
import { normalizeBackendErrorEvent } from "../../utils/errors";
import { redactSecretsFromString } from "../../utils/redact";
import { isAcpRequest, type AcpRequest } from "./protocol";
import type { AcpInboundFrame, AcpReply, AcpTransport } from "./transport";
import {
  buildAcpPermissionToolCall,
  finishReasonForAcpStopReason,
  normalizeAcpNotification
} from "./events";

/** ACP uses a single integer major protocol version. */
const ACP_PROTOCOL_VERSION = 1;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Options honored by the ACP session adapter. */
export interface AcpSessionOptions {
  /** Approval-only execution seam for ACP permission requests. */
  execute: AgentTurnOptions["execute"];
  shouldCancel?: () => boolean;
  contextPrefix?: string;
  maxToolCalls?: number;
  maxToolOutputCharacters?: number;
  maxTurns?: number;
}

function errorEvent(message: string): Extract<BackendAgentEvent, { type: "error" }> {
  return normalizeBackendErrorEvent({
    type: "error",
    message: redactSecretsFromString(message)
  });
}

function replyError(reply: Extract<AcpReply, { ok: false }>): BackendAgentEvent {
  return errorEvent(reply.error.message || "ACP request failed.");
}

function sessionIdFrom(result: unknown): string | null {
  const value = object(result)?.sessionId;
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
}

function promptText(request: AgentTurnRequest, contextPrefix?: string): string {
  const messages = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const current = messages.at(-1) ?? "";
  return [contextPrefix?.trim(), current].filter(Boolean).join("\n\n");
}

interface AuthMethod {
  id: string;
}

function authMethods(result: unknown): AuthMethod[] {
  const raw = object(result)?.authMethods;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => object(entry)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => ({ id }));
}

function orderedAuthMethods(providerId: string, methods: AuthMethod[]): AuthMethod[] {
  if (providerId !== "grok") return methods.slice(0, 1);
  // Grok's official ACP integration offers cached login and XAI_API_KEY auth.
  // Try the cached desktop login first, then the environment-backed key.
  const preference = ["cached_token", "xai.api_key"];
  return [...methods].sort((a, b) => {
    const ai = preference.indexOf(a.id);
    const bi = preference.indexOf(b.id);
    return (ai < 0 ? preference.length : ai) - (bi < 0 ? preference.length : bi);
  });
}

async function authenticateIfAdvertised(
  transport: AcpTransport,
  providerId: string,
  initializeResult: unknown,
  requestFor: (method: string, params: unknown) => AcpRequest,
  required: boolean
): Promise<AcpReply | null> {
  if (providerId !== "grok" && !required) return null;
  const methods = orderedAuthMethods(providerId, authMethods(initializeResult));
  if (methods.length === 0) return null;

  let lastFailure: AcpReply | null = null;
  for (const method of methods) {
    const reply = await transport.request(
      requestFor("authenticate", {
        methodId: method.id,
        _meta: { headless: true }
      })
    );
    if (reply.ok) return reply;
    lastFailure = reply;
  }
  return lastFailure;
}

function isAuthenticationError(reply: Extract<AcpReply, { ok: false }>): boolean {
  const diagnostic = JSON.stringify(reply.error).toLowerCase();
  return /auth_required|authentication required|not authenticated|not logged in|sign[ -]?in|login|unauthorized/.test(
    diagnostic
  );
}

interface PermissionOption {
  optionId: string;
  kind: string;
}

function permissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const option = object(candidate);
    return typeof option?.optionId === "string" && typeof option.kind === "string"
      ? [{ optionId: option.optionId, kind: option.kind }]
      : [];
  });
}

function permissionOutcome(options: PermissionOption[], granted: boolean): unknown {
  const desiredKind = granted ? "allow_once" : "reject_once";
  const selected = options.find((option) => option.kind === desiredKind);
  return selected
    ? { outcome: "selected", optionId: selected.optionId }
    : { outcome: "cancelled" };
}

async function sendRequestError(
  transport: AcpTransport,
  request: AcpRequest,
  code: number,
  message: string
): Promise<void> {
  await transport.send({
    jsonrpc: "2.0",
    id: request.id,
    error: { code, message }
  });
}

/**
 * Run one prompt turn using the ACP v1 lifecycle:
 * initialize -> optional authenticate -> session/new -> session/prompt.
 * `session/prompt` resolves only at end-of-turn, so inbound updates and
 * permission requests are consumed concurrently while that request is pending.
 */
export async function* runAcpSession(
  transport: AcpTransport,
  providerId: string,
  request: AgentTurnRequest,
  options: AcpSessionOptions
): AsyncIterable<BackendAgentEvent> {
  const maxPermissionRequests = Math.min(
    options.maxToolCalls ?? MAX_TOOL_CALLS_PER_RUN,
    options.maxTurns ?? MAX_TOOL_CALLS_PER_RUN
  );
  const maxToolOutputCharacters =
    options.maxToolOutputCharacters ?? MAX_TOOL_OUTPUT_CHARACTERS;
  let requestSequence = 0;
  let sessionId: string | null = null;
  let permissionCount = 0;
  let cancellationSent = false;
  const seenPermissionCallIds = new Set<string>();

  const requestFor = (method: string, params: unknown): AcpRequest => ({
    jsonrpc: "2.0",
    id: `fable-${++requestSequence}`,
    method,
    params
  });

  try {
    const initialize = await transport.request(
      requestFor("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "fable", title: "Fable", version: "1" }
      })
    );
    if (!initialize.ok) {
      yield replyError(initialize);
      return;
    }
    if (object(initialize.result)?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      yield errorEvent("The ACP agent negotiated an unsupported protocol version.");
      return;
    }

    const authentication = await authenticateIfAdvertised(
      transport,
      providerId,
      initialize.result,
      requestFor,
      false
    );
    if (authentication && !authentication.ok) {
      yield replyError(authentication);
      return;
    }

    let newSession = await transport.request(
      requestFor("session/new", {
        cwd: transport.cwd,
        mcpServers: []
      })
    );
    if (
      !newSession.ok &&
      providerId !== "grok" &&
      isAuthenticationError(newSession) &&
      authMethods(initialize.result).length > 0
    ) {
      const retryAuthentication = await authenticateIfAdvertised(
        transport,
        providerId,
        initialize.result,
        requestFor,
        true
      );
      if (retryAuthentication && !retryAuthentication.ok) {
        yield replyError(retryAuthentication);
        return;
      }
      newSession = await transport.request(
        requestFor("session/new", { cwd: transport.cwd, mcpServers: [] })
      );
    }
    if (!newSession.ok) {
      yield replyError(newSession);
      return;
    }
    sessionId = sessionIdFrom(newSession.result);
    if (!sessionId) {
      yield errorEvent("The ACP agent returned an invalid session id.");
      return;
    }

    const text = promptText(request, options.contextPrefix);
    if (!text) {
      yield errorEvent("The ACP prompt is empty.");
      return;
    }

    const promptReply = transport.request(
      requestFor("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }]
      })
    );
    const iterator = transport.frames()[Symbol.asyncIterator]();
    let nextFrame = iterator.next();

    while (true) {
      if (options.shouldCancel?.() === true) {
        await transport.send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId }
        });
        cancellationSent = true;
        yield { type: "cancelled" };
        return;
      }

      const raced = await Promise.race([
        nextFrame.then((value) => ({ kind: "frame" as const, value })),
        promptReply.then((reply) => ({ kind: "prompt" as const, reply }))
      ]);

      if (raced.kind === "prompt") {
        if (!raced.reply.ok) {
          yield replyError(raced.reply);
          return;
        }
        const stopReason = object(raced.reply.result)?.stopReason;
        yield { type: "done", finishReason: finishReasonForAcpStopReason(stopReason) };
        return;
      }

      if (raced.value.done) {
        if (options.shouldCancel?.() === true) {
          yield { type: "cancelled" };
        } else {
          yield errorEvent("The ACP process closed before the prompt completed.");
        }
        return;
      }
      const frame: AcpInboundFrame = raced.value.value;
      nextFrame = iterator.next();

      if (!isAcpRequest(frame)) {
        const event = normalizeAcpNotification(providerId, frame);
        if (!event) continue;
        if (event.type === "tool-result" && event.output.length > maxToolOutputCharacters) {
          yield { ...event, output: `${event.output.slice(0, maxToolOutputCharacters)}…` };
        } else {
          yield event;
        }
        continue;
      }

      if (frame.method !== "session/request_permission") {
        await sendRequestError(transport, frame, -32601, "Method not supported by Fable.");
        continue;
      }

      const params = object(frame.params);
      if (!params || params.sessionId !== sessionId) {
        await transport.send({
          jsonrpc: "2.0",
          id: frame.id,
          result: { outcome: { outcome: "cancelled" } }
        });
        continue;
      }
      const permission = buildAcpPermissionToolCall(
        providerId,
        sessionId,
        frame.id,
        params.toolCall
      );
      const choices = permissionOptions(params.options);
      // Fable never upgrades a one-time user decision to a standing provider
      // grant. If the agent does not offer `allow_once`, cancel without asking.
      if (!choices.some((choice) => choice.kind === "allow_once")) {
        await transport.send({
          jsonrpc: "2.0",
          id: frame.id,
          result: { outcome: { outcome: "cancelled" } }
        });
        continue;
      }
      if (!permission || permission.arguments.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
        await transport.send({
          jsonrpc: "2.0",
          id: frame.id,
          result: { outcome: permissionOutcome(choices, false) }
        });
        continue;
      }
      if (seenPermissionCallIds.has(permission.callId)) {
        await transport.send({
          jsonrpc: "2.0",
          id: frame.id,
          result: { outcome: permissionOutcome(choices, false) }
        });
        yield errorEvent("The ACP agent replayed a permission request; Fable refused it.");
        return;
      }
      if (permissionCount >= maxPermissionRequests) {
        await transport.send({
          jsonrpc: "2.0",
          id: frame.id,
          result: { outcome: permissionOutcome(choices, false) }
        });
        yield errorEvent(`ACP run exceeded its permission-request cap (${maxPermissionRequests}).`);
        return;
      }

      permissionCount += 1;
      seenPermissionCallIds.add(permission.callId);
      const event: Extract<BackendAgentEvent, { type: "tool-call" }> = {
        type: "tool-call",
        callId: permission.callId,
        tool: "acp-permission",
        arguments: permission.arguments,
        approval: permission.approval
      };
      yield event;

      let granted = false;
      try {
        await options.execute(event.approval, event.arguments);
        granted = true;
      } catch {
        granted = false;
      }
      await transport.send({
        jsonrpc: "2.0",
        id: frame.id,
        result: { outcome: permissionOutcome(choices, granted) }
      });
      if (!granted) {
        yield {
          type: "tool-result",
          callId: event.callId,
          ok: false,
          output: "Permission denied."
        };
      }
    }
  } catch (error) {
    yield errorEvent(
      error instanceof Error ? error.message : "Fable could not communicate with the ACP agent."
    );
  } finally {
    if (sessionId && options.shouldCancel?.() === true && !cancellationSent) {
      await transport
        .send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId }
        })
        .catch(() => undefined);
    }
    await transport.close().catch(() => undefined);
  }
}
