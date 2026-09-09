/** Official endpoints only. Presence is a setup route, never connection evidence. */
export interface RemoteConnector {
  id: string;
  name: string;
  endpoint: string;
  documentation: string;
  prerequisite?: string;
}

export const remoteConnectors: readonly RemoteConnector[] = [
  { id: "notion", name: "Notion", endpoint: "https://mcp.notion.com/mcp", documentation: "https://developers.notion.com/guides/mcp/get-started-with-mcp" },
  { id: "linear", name: "Linear", endpoint: "https://mcp.linear.app/mcp", documentation: "https://linear.app/docs/mcp" },
  { id: "vercel", name: "Vercel", endpoint: "https://mcp.vercel.com", documentation: "https://vercel.com/docs/agent-resources/vercel-mcp" },
  { id: "canva", name: "Canva", endpoint: "https://mcp.canva.com/mcp", documentation: "https://www.canva.dev/docs/mcp/" },
  { id: "figma", name: "Figma", endpoint: "https://mcp.figma.com/mcp", documentation: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/", prerequisite: "Figma client approval and a supported plan/seat may be required." },
  { id: "sentry", name: "Sentry", endpoint: "https://mcp.sentry.dev/mcp", documentation: "https://mcp.sentry.dev/" },
  { id: "stripe", name: "Stripe", endpoint: "https://mcp.stripe.com", documentation: "https://docs.stripe.com/mcp" },
  { id: "cloudflare", name: "Cloudflare", endpoint: "https://mcp.cloudflare.com/mcp", documentation: "https://developers.cloudflare.com/agent-setup/codex/" },
  { id: "granola", name: "Granola", endpoint: "https://mcp.granola.ai/mcp", documentation: "https://docs.granola.ai/help-center/sharing/integrations/mcp" },
];

export function remoteConnectorFor(id: string) {
  return remoteConnectors.find((connector) => connector.id === id);
}

export function remoteConnectorServerId(id: string) {
  return `marketplace-${id}`;
}
