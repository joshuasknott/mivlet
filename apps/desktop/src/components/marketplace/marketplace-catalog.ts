import { tokenPluginFor } from "@fable/connectors/providers/token-plugins";

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
  | "docusign"
  | "figma"
  | "finance"
  | "google"
  | "instagram"
  | "linkedin"
  | "meta"
  | "microsoft-outlook"
  | "microsoft-teams"
  | "people"
  | "product"
  | "security"
  | "youtube";

const entry = (
  id: string,
  name: string,
  description: string,
  icon: MarketplaceIconName,
  recommended = false,
): MarketplaceConnectorEntry => ({
  id,
  name,
  description: tokenPluginFor(id)?.description ?? description,
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
      entry(
        "todoist",
        "Todoist",
        "Plan, capture, and track tasks and projects",
        "product",
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
        "outlook",
        "Outlook",
        "Work with Microsoft email and calendars",
        "microsoft-outlook",
      ),
      entry(
        "microsoft-teams",
        "Microsoft Teams",
        "Find conversations, meetings, and files",
        "microsoft-teams",
      ),
      entry(
        "zoom",
        "Zoom",
        "Use meeting details and recordings",
        "communication",
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
    id: "marketing-social",
    title: "Marketing & social",
    connectors: [
      entry(
        "linkedin",
        "LinkedIn",
        "Prepare and review professional content",
        "linkedin",
      ),
      entry(
        "instagram",
        "Instagram",
        "Plan and review social content",
        "instagram",
      ),
      entry(
        "youtube",
        "YouTube",
        "Work with channels, videos, and analytics",
        "youtube",
      ),
      entry(
        "google-ads",
        "Google Ads",
        "Review campaigns and performance",
        "google",
      ),
      entry(
        "meta-ads",
        "Meta Ads",
        "Review campaigns across Meta properties",
        "meta",
      ),
    ],
  },
  {
    id: "commerce-support",
    title: "Commerce & support",
    connectors: [
      entry(
        "shopify",
        "Shopify",
        "Work with products, orders, and customers",
        "commerce",
        true,
      ),
      entry(
        "stripe",
        "Stripe",
        "Inspect payments, customers, and subscriptions",
        "finance",
      ),
    ],
  },
  {
    id: "legal-compliance",
    title: "Legal & compliance",
    connectors: [
      entry(
        "docusign",
        "DocuSign",
        "Review envelopes and agreement status",
        "docusign",
      ),
    ],
  },
  {
    id: "people-recruiting",
    title: "People & recruiting",
    connectors: [
      entry(
        "greenhouse",
        "Greenhouse",
        "Work with candidates and hiring plans",
        "people",
      ),
      entry(
        "lever",
        "Lever",
        "Manage recruiting pipelines and interviews",
        "people",
      ),
      entry(
        "workday",
        "Workday",
        "Use approved people and finance records",
        "people",
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
