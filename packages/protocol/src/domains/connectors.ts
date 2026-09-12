/** Connector identity primitives live in a leaf domain. */
export type SupportedConnectorId =
  | "github"
  | "vercel"
  | "google-drive"
  | "notion"
  | "gmail"
  | "slack"
  | "google-calendar"
  | "linear"
  | "outlook"
  | "microsoft-teams"
  | "zoom"
  | "linkedin"
  | "instagram"
  | "youtube"
  | "google-ads"
  | "meta-ads"
  | "shopify"
  | "docusign"
  | "greenhouse"
  | "lever"
  | "workday";

export type ConnectorId = "local-files" | SupportedConnectorId | (string & {});
