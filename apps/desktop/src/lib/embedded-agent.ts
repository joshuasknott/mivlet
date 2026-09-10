import type { BackendProvider } from "@fable/protocol";
import { resolveModelCapabilities, type EmbeddedRuntimeEvent, type EmbeddedRuntimeHandle } from "@fable/connectors";
import { startRuntimeEmbeddedAgent, cancelRuntimeEmbeddedAgent, replyRuntimeEmbeddedAgent, listenRuntimeEmbeddedAgent } from "../runtime";

export function createDesktopEmbeddedRuntime(_provider: BackendProvider): EmbeddedRuntimeHandle | null {
  if (typeof window === "undefined" || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return null;
  const requestId = `sdk-${crypto.randomUUID()}`;
  let cancelled = false;
  let wake: (() => void) | undefined;
  return {
    async *run(request, options) {
      const queue: EmbeddedRuntimeEvent[] = [];
      let terminal = false;
      const unlisten = await listenRuntimeEmbeddedAgent(requestId, event => {
        if (cancelled) return;
        queue.push(event);
        if (["done", "error", "cancelled"].includes(event.type)) terminal = true;
        wake?.(); wake = undefined;
      });
      if (!unlisten) throw new Error("The native agent event channel is unavailable.");
      try {
        if (cancelled) { yield { type: "cancelled" }; return; }
        await startRuntimeEmbeddedAgent({ requestId, providerId: _provider.id, request,
          contextPrefix: options.contextPrefix, computer: options.computer,
          contextWindow: resolveModelCapabilities(_provider.id, _provider.models.find(model => model.id === request.model))?.contextWindow ?? 128_000,
          maxTurns: options.maxTurns ?? 8, maxToolCalls: options.maxToolCalls ?? 32 });
        if (cancelled) await cancelRuntimeEmbeddedAgent(requestId);
        while (!cancelled && (!terminal || queue.length)) {
          if (queue.length) yield queue.shift()!;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
        if (cancelled) yield { type: "cancelled" };
      } finally { unlisten(); await cancelRuntimeEmbeddedAgent(requestId); }
    },
    async reply(callId, ok, output) {
      if (cancelled) throw new Error("The agent was stopped.");
      await replyRuntimeEmbeddedAgent(requestId, callId, ok, output);
    },
    async cancel() { cancelled = true; wake?.(); wake = undefined; await cancelRuntimeEmbeddedAgent(requestId); },
  };
}
