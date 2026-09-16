import { redactSecretsFromString } from "@mivlet/connectors/agent-runtime";

/** Provider tool errors are still untrusted text, not successful executions. */
export function assertConnectorToolSucceeded(result: unknown): void {
  if (!result || typeof result !== "object" || !("isError" in result) || result.isError !== true) return;
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const message = content.filter((item): item is { text: string } => Boolean(item && typeof item === "object" && "text" in item && typeof item.text === "string"))
    .map((item) => item.text).join("\n");
  throw new Error(redactSecretsFromString(message || "The connected app could not complete this action.").slice(0, 2_000));
}

export function connectorErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Could not connect. Try again.";
  return redactSecretsFromString(message).slice(0, 2_000);
}
