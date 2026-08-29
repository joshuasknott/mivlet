/** Connector identity primitives live in a leaf domain. */
export type SupportedConnectorId =
  | "github"
  | "vercel"
  | "google-drive"
  | "notion"
  | "gmail"
  | "slack"
  | "google-calendar"
  | "linear";

export type ConnectorId = "local-files" | SupportedConnectorId | (string & {});
