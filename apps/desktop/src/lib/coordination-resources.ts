/** Conservative write reservations complement native access and exact approval
 * checks. Connector tools are opaque, so reserve the whole connected service;
 * private file namespaces remain separate for each configured agent. */
export function coordinationResource(tool: string, argumentsJson: string, agentId: string): string | null {
  if (!["write-file", "create-document", "create-spreadsheet", "connector-action", "connector-call"].includes(tool)) return null;
  const args: Record<string, unknown> = JSON.parse(argumentsJson);
  if (tool === "connector-action" || tool === "connector-call") {
    if (typeof args.connectorId !== "string" || !args.connectorId) throw new Error("A connector write needs an exact connector ID.");
    return `connector:${args.connectorId.toLowerCase()}`;
  }
  if (typeof args.path !== "string" || !args.path) throw new Error("A file write needs an exact workspace path.");
  const segments: string[] = [];
  for (const segment of args.path.replace(/\\/g, "/").toLowerCase().split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error("File paths cannot traverse outside the agent workspace.");
    segments.push(segment);
  }
  return `agent-file:${agentId}:${segments.join("/")}`;
}
