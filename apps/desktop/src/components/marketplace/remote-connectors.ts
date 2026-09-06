/** Official endpoints only. Presence is a setup route, never connection evidence. */
export interface RemoteConnector {
  id: string;
  name: string;
  endpoint: string;
  documentation: string;
  prerequisite?: string;
  regions?: readonly { name: string; endpoint: string }[];
}

export const remoteConnectors: readonly RemoteConnector[] = [
  { id: "notion", name: "Notion", endpoint: "https://mcp.notion.com/mcp", documentation: "https://developers.notion.com/guides/mcp/get-started-with-mcp" },
  { id: "linear", name: "Linear", endpoint: "https://mcp.linear.app/mcp", documentation: "https://linear.app/docs/mcp" },
  { id: "vercel", name: "Vercel", endpoint: "https://mcp.vercel.com", documentation: "https://vercel.com/docs/agent-resources/vercel-mcp" },
  { id: "canva", name: "Canva", endpoint: "https://mcp.canva.com/mcp", documentation: "https://www.canva.dev/docs/mcp/" },
  { id: "figma", name: "Figma", endpoint: "https://mcp.figma.com/mcp", documentation: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/", prerequisite: "Figma client approval and a supported plan/seat may be required." },
  { id: "jira", name: "Jira", endpoint: "https://mcp.atlassian.com/v2/mcp", documentation: "https://atlassian.github.io/atlassian-mcp-server/", prerequisite: "Your administrator may need to allow Fable." },
  { id: "sentry", name: "Sentry", endpoint: "https://mcp.sentry.dev/mcp", documentation: "https://mcp.sentry.dev/" },
  { id: "stripe", name: "Stripe", endpoint: "https://mcp.stripe.com", documentation: "https://docs.stripe.com/mcp" },
  { id: "miro", name: "Miro", endpoint: "https://mcp.miro.com/", documentation: "https://developers.miro.com/docs/connecting-to-miro-mcp" },
  { id: "cloudflare", name: "Cloudflare", endpoint: "https://mcp.cloudflare.com/mcp", documentation: "https://developers.cloudflare.com/agent-setup/codex/" },
  { id: "granola", name: "Granola", endpoint: "https://mcp.granola.ai/mcp", documentation: "https://docs.granola.ai/help-center/sharing/integrations/mcp" },
  { id: "airtable", name: "Airtable", endpoint: "https://mcp.airtable.com/mcp", documentation: "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server" },
  { id: "amplitude", name: "Amplitude", endpoint: "https://mcp.amplitude.com/mcp", documentation: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp", regions: [
    { name: "United States", endpoint: "https://mcp.amplitude.com/mcp" }, { name: "European Union", endpoint: "https://mcp.eu.amplitude.com/mcp" },
  ] },
  { id: "mixpanel", name: "Mixpanel", endpoint: "https://mcp.mixpanel.com/mcp", documentation: "https://docs.mixpanel.com/docs/mcp", regions: [
    { name: "United States", endpoint: "https://mcp.mixpanel.com/mcp" }, { name: "European Union", endpoint: "https://mcp-eu.mixpanel.com/mcp" }, { name: "India", endpoint: "https://mcp-in.mixpanel.com/mcp" },
  ] },
  { id: "vanta", name: "Vanta", endpoint: "https://mcp.vanta.com/mcp", documentation: "https://help.vanta.com/en/articles/14094979-connecting-to-vanta-mcp", prerequisite: "Requires a Vanta administrator account.", regions: [
    { name: "United States", endpoint: "https://mcp.vanta.com/mcp" }, { name: "European Union", endpoint: "https://mcp.eu.vanta.com/mcp" }, { name: "Australia", endpoint: "https://mcp.aus.vanta.com/mcp" },
  ] },
  { id: "ramp", name: "Ramp", endpoint: "https://mcp.ramp.com/mcp", documentation: "https://agents.ramp.com/docs/guides/connecting", prerequisite: "Ramp must allow Fable's loopback redirect. Request access using the provider guide." },
];

export function remoteConnectorFor(id: string) {
  return remoteConnectors.find((connector) => connector.id === id);
}

export function remoteConnectorServerId(id: string) {
  return `marketplace-${id}`;
}
