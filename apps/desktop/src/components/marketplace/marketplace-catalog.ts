
export interface MarketplaceConnectorEntry {
  id: string;
  name: string;
  description: string;
  icon: MarketplaceIconName;
  recommended?: boolean;
}

export interface MarketplaceConnectorSection {
  id: string;
  title: string;
  connectors: MarketplaceConnectorEntry[];
}

export type MarketplaceIconName =
  | "calendar"
  | "canva"
  | "cloud"
  | "commerce"
  | "communication"
  | "figma"
  | "finance"
  | "google"
  | "people"
  | "product"
  | "security";

const entry = (
  id: string,
  name: string,
  description: string,
  icon: MarketplaceIconName,
  recommended = false,
): MarketplaceConnectorEntry => ({
  id,
  name,
  description,
  icon,
  ...(recommended ? { recommended: true } : {}),
});

/**
 * Product catalogue only. Native manifests and official remote setup routes
 * determine availability; catalogue entries never establish authorization.
 */
export const marketplaceConnectorSections: MarketplaceConnectorSection[] = [
  {
    id: "work-knowledge",
    title: "Work & knowledge",
    connectors: [
      entry(
        "google-drive",
        "Google Drive",
        "Find and work with your Drive files",
        "google",
        true,
      ),
      entry(
        "notion",
        "Notion",
        "Search selected pages and databases",
        "product",
        true,
      ),
      entry(
        "atlassian-rovo",
        "Atlassian Rovo",
        "Search and summarize across Jira, Confluence, and more",
        "communication",
      ),
    ],
  },
  {
    id: "communication-meetings",
    title: "Communication & meetings",
    connectors: [
      entry(
        "gmail",
        "Gmail",
        "Search mail and prepare replies",
        "communication",
        true,
      ),
      entry(
        "slack",
        "Slack",
        "Read selected conversations and post with approval",
        "communication",
        true,
      ),
      entry(
        "google-calendar",
        "Google Calendar",
        "Read calendars and manage events with approval",
        "calendar",
        true,
      ),
      entry(
        "granola",
        "Granola",
        "Bring meeting notes into agent context",
        "communication",
      ),
    ],
  },
  {
    id: "product-design",
    title: "Product & design",
    connectors: [
      entry(
        "figma",
        "Figma",
        "Inspect designs, components, and comments",
        "figma",
        true,
      ),
      entry("canva", "Canva", "Create and share team designs", "canva"),
    ],
  },
  {
    id: "engineering-delivery",
    title: "Engineering & delivery",
    connectors: [
      entry(
        "github",
        "GitHub",
        "Work with repositories, issues, and pull requests",
        "product",
        true,
      ),
      entry(
        "vercel",
        "Vercel",
        "Review projects and deployments",
        "cloud",
      ),
      entry(
        "linear",
        "Linear",
        "Read workspace data and prepare approved issue changes",
        "product",
      ),
      entry("sentry", "Sentry", "Investigate errors and releases", "security"),
      entry(
        "cloudflare",
        "Cloudflare",
        "Inspect applications, traffic, and deployments",
        "cloud",
      ),
    ],
  },
  {
    id: "commerce-support",
    title: "Commerce & support",
    connectors: [
      entry(
        "stripe",
        "Stripe",
        "Inspect payments, customers, and subscriptions",
        "finance",
      ),
    ],
  },
];

export const marketplaceConnectorEntries = marketplaceConnectorSections.flatMap(
  (section) => section.connectors,
);

export const recommendedMarketplaceConnectors =
  marketplaceConnectorEntries.filter((connector) => connector.recommended);

export function findMarketplaceConnector(id: string) {
  return marketplaceConnectorEntries.find((connector) => connector.id === id);
}
