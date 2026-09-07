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
  | "airtable"
  | "analytics"
  | "automation"
  | "box"
  | "calendar"
  | "canva"
  | "cloud"
  | "coda"
  | "commerce"
  | "communication"
  | "compliance"
  | "crm"
  | "data"
  | "docusign"
  | "dropbox"
  | "figma"
  | "finance"
  | "gitlab"
  | "google"
  | "instagram"
  | "learning"
  | "legal"
  | "linkedin"
  | "marketing"
  | "meta"
  | "microsoft-outlook"
  | "microsoft-teams"
  | "operations"
  | "people"
  | "product"
  | "research"
  | "sales"
  | "security"
  | "support"
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
      entry("dropbox", "Dropbox", "Search shared files and folders", "dropbox"),
      entry("box", "Box", "Work with governed company content", "box"),
      entry(
        "airtable",
        "Airtable",
        "Read bases, records, and views",
        "airtable",
      ),
      entry("coda", "Coda", "Use docs, tables, and team knowledge", "coda"),
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
        "fathom",
        "Fathom",
        "Search meeting notes and transcripts",
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
      entry("miro", "Miro", "Collaborate on boards and diagrams", "product"),
      entry(
        "productboard",
        "Productboard",
        "Track feedback and roadmap items",
        "product",
      ),
      entry(
        "framer",
        "Framer",
        "Work with sites and design projects",
        "product",
      ),
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
      entry("gitlab", "GitLab", "Manage projects and merge requests", "gitlab"),
      entry(
        "jira",
        "Jira",
        "Track projects, issues, and delivery work",
        "product",
      ),
      entry("sentry", "Sentry", "Investigate errors and releases", "security"),
      entry(
        "datadog",
        "Datadog",
        "Search telemetry, incidents, and monitors",
        "analytics",
      ),
      entry(
        "cloudflare",
        "Cloudflare",
        "Inspect applications, traffic, and deployments",
        "cloud",
      ),
    ],
  },
  {
    id: "data-analytics",
    title: "Data & analytics",
    connectors: [
      entry("bigquery", "BigQuery", "Query governed warehouse data", "data"),
      entry(
        "snowflake",
        "Snowflake",
        "Explore approved datasets and views",
        "data",
      ),
      entry(
        "looker",
        "Looker",
        "Find dashboards and governed metrics",
        "analytics",
      ),
      entry(
        "mixpanel",
        "Mixpanel",
        "Analyse product events and funnels",
        "analytics",
      ),
      entry(
        "amplitude",
        "Amplitude",
        "Understand journeys and product behaviour",
        "analytics",
      ),
      entry("tableau", "Tableau", "Search dashboards and reports", "analytics"),
    ],
  },
  {
    id: "sales-crm",
    title: "Sales & CRM",
    connectors: [
      entry(
        "salesforce",
        "Salesforce",
        "Work with accounts, contacts, and opportunities",
        "crm",
      ),
      entry(
        "hubspot",
        "HubSpot",
        "Use CRM, marketing, and service records",
        "crm",
      ),
      entry(
        "pipedrive",
        "Pipedrive",
        "Track deals and sales activity",
        "sales",
      ),
      entry(
        "apollo",
        "Apollo.io",
        "Research prospects and sales engagement",
        "sales",
      ),
      entry(
        "intercom",
        "Intercom",
        "Use customer conversations and account context",
        "support",
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
        "mailchimp",
        "Mailchimp",
        "Prepare campaigns and audience updates",
        "marketing",
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
      entry(
        "zendesk",
        "Zendesk",
        "Search tickets and prepare support replies",
        "support",
      ),
      entry(
        "gorgias",
        "Gorgias",
        "Use ecommerce support conversations",
        "support",
      ),
      entry(
        "woocommerce",
        "WooCommerce",
        "Manage store products and orders",
        "commerce",
      ),
    ],
  },
  {
    id: "finance-accounting",
    title: "Finance & accounting",
    connectors: [
      entry(
        "quickbooks",
        "QuickBooks",
        "Review transactions, invoices, and reports",
        "finance",
      ),
      entry(
        "xero",
        "Xero",
        "Use accounting records and reconciliations",
        "finance",
      ),
      entry(
        "netsuite",
        "NetSuite",
        "Work with finance and operations records",
        "finance",
      ),
      entry(
        "ramp",
        "Ramp",
        "Review spend, cards, and reimbursements",
        "finance",
      ),
      entry(
        "brex",
        "Brex",
        "Review spend and company card activity",
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
      entry(
        "ironclad",
        "Ironclad",
        "Work with contracts and approvals",
        "legal",
      ),
      entry(
        "vanta",
        "Vanta",
        "Review controls and compliance evidence",
        "compliance",
      ),
      entry(
        "drata",
        "Drata",
        "Inspect compliance controls and evidence",
        "compliance",
      ),
      entry(
        "onetrust",
        "OneTrust",
        "Use privacy, risk, and consent records",
        "compliance",
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
      entry("deel", "Deel", "Review global people operations", "operations"),
      entry(
        "bamboohr",
        "BambooHR",
        "Use employee and time-off records",
        "people",
      ),
    ],
  },
  {
    id: "operations-security-automation",
    title: "Operations, security & automation",
    connectors: [
      entry(
        "zapier",
        "Zapier",
        "Trigger approved cross-app workflows",
        "automation",
      ),
      entry("make", "Make", "Run approved visual automations", "automation"),
      entry("n8n", "n8n", "Use self-hosted workflows and tools", "automation"),
      entry(
        "servicenow",
        "ServiceNow",
        "Work with service operations records",
        "operations",
      ),
      entry(
        "pagerduty",
        "PagerDuty",
        "Review incidents and on-call activity",
        "security",
      ),
    ],
  },
  {
    id: "research-learning",
    title: "Research & learning",
    connectors: [
      entry(
        "perplexity",
        "Perplexity",
        "Research topics with source context",
        "research",
      ),
      entry(
        "consensus",
        "Consensus",
        "Search evidence across research papers",
        "learning",
      ),
      entry(
        "scispace",
        "SciSpace",
        "Explore and explain academic literature",
        "learning",
      ),
      entry("arxiv", "arXiv", "Search open research preprints", "research"),
      entry(
        "wolfram",
        "Wolfram",
        "Use computational knowledge and data",
        "data",
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
