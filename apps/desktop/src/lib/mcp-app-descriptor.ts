import type { McpAppDescriptor } from "./conversation-presentation-types";

function mcpAppDescriptor(value: unknown): McpAppDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = (value as Record<string, unknown>).mcpApp;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return undefined;
  const record = candidate as Record<string, unknown>;
  if (
    typeof record.connectorId !== "string" ||
    record.connectorId.length > 256 ||
    typeof record.toolName !== "string" ||
    record.toolName.length > 128 ||
    typeof record.resourceUri !== "string" ||
    !record.resourceUri.startsWith("ui://") ||
    record.resourceUri.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(record.resourceUri)
  )
    return undefined;
  return {
    connectorId: record.connectorId,
    toolName: record.toolName,
    resourceUri: record.resourceUri,
  };
}

export function resultMcpApp(content: string): McpAppDescriptor | undefined {
  try {
    return mcpAppDescriptor(JSON.parse(content));
  } catch {
    return undefined;
  }
}

