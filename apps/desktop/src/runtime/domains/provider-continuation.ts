import type {
  ProviderContinuation,
  ProviderContinuationInput,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

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

export async function previewProviderContinuation(
  workspaceId: string,
  input: ProviderContinuationInput,
): Promise<ProviderContinuation> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native")
    throw new Error(
      "Provider continuation requires the installed desktop app.",
    );
  try {
    return await adapter.invoke<ProviderContinuation>(
      "provider_continuation_preview",
      { request: { workspaceId, input } },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}
