import type { HostedTextProviderId } from "@mivlet/protocol";
import { getActiveRuntimeDataScope } from "../../runtime-scope";

export const hostedProviderLabels: Record<HostedTextProviderId, string> = {
  openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", xai: "xAI", deepseek: "DeepSeek",
};

const scopeKeys = new WeakMap<object, number>();
let nextScopeKey = 0;
/** Account/workspace tokens can change while public Work/agent IDs stay equal. */
export function hostedScopeKey() {
  const scope = getActiveRuntimeDataScope();
  if (!scope) return "unavailable";
  const existing = scopeKeys.get(scope);
  if (existing !== undefined) return existing;
  const key = ++nextScopeKey;
  scopeKeys.set(scope, key);
  return key;
}

/** A lost reply requires an authoritative reread, never an automatic mutation retry. */
export async function boundedHostedRead<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The cloud service did not respond. Refresh status before trying another action.")), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}
