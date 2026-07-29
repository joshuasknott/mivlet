/**
 * Connector identity primitives live in a leaf domain so scheduling and other
 * protocol domains never import the root barrel.
 */
export type FirstWaveConnectorId =
  | "github"
  | "vercel"
  | "google-drive"
  | "notion"
  | "gmail"
  | "slack"
  | "google-calendar"
  | "linear";

export type ConnectorId = "local-files" | FirstWaveConnectorId | (string & {});
