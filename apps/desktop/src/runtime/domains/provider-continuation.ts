import { getRuntimeAdapter } from "../adapters/select";

export async function readProviderContinuation(request: {
  workspaceId: string;
  id: string;
  generation: number;
  runId: string;
  sequence: number;
  textOffset: number;
}): Promise<unknown> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native")
    throw new Error(
      "Saved-history retrieval requires the installed desktop app.",
    );
  return adapter.invoke("provider_continuation_read", { request });
}
