// A chat identity carries only a saved configuration reference. Hex preserves
// legacy dots/underscores while keeping @mentions unambiguous and reversible.
const validReference = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  && !value.startsWith("marketplace-");
export function customMcpConnectorId(reference: string): string | undefined {
  return validReference(reference) ? `mcp-${[...reference].map(char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")}` : undefined;
}
export function customMcpServerReference(id: string): string | undefined {
  const encoded = /^mcp-((?:[0-9a-f]{2}){1,128})$/.exec(id)?.[1];
  if (!encoded) return undefined;
  const reference = encoded.match(/../g)!.map(byte => String.fromCharCode(Number.parseInt(byte, 16))).join("");
  return validReference(reference) ? reference : undefined;
}
