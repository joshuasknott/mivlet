import type { ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export type NotionWriteAction = "notion.create-page" | "notion.update-page" | "notion.append-blocks" | "notion.update-block" | "notion.delete-block" | "notion.create-comment" | "notion.create-entry";
const NOTION_WRITE_POLICY: Record<NotionWriteAction, { risk: "medium" | "critical"; consequence: string }> = {
  "notion.create-page": { risk: "medium", consequence: "Creates a page in the selected Notion destination." },
  "notion.update-page": { risk: "medium", consequence: "Updates the selected Notion page and properties." },
  "notion.append-blocks": { risk: "medium", consequence: "Appends the proposed blocks to the selected Notion page." },
  "notion.update-block": { risk: "medium", consequence: "Updates the selected Notion block." },
  "notion.delete-block": { risk: "critical", consequence: "Archives the selected Notion block." },
  "notion.create-comment": { risk: "medium", consequence: "Creates the proposed comment on the selected Notion page." },
  "notion.create-entry": { risk: "medium", consequence: "Creates an entry in the selected Notion database." }
};

export function prepareNotionWrite(action: NotionWriteAction, input: { workspace: string; targetId: string; destination: string; body: unknown; changedProperties?: string[] }) {
  const policy = NOTION_WRITE_POLICY[action];
  return prepareConnectorAction("notion", "Notion", action, { workspace: input.workspace, targetId: input.targetId, destination: input.destination, body: JSON.stringify(input.body), changedProperties: (input.changedProperties ?? []).join(", ") }, policy.risk, policy.consequence);
}

export interface NotionPayload {
  id: string;
  object: "page" | "database";
  title: string;
  workspace: string;
  lastEditedTime?: string;
  url?: string;
  plainText?: string;
}

export function normalizeNotionItem(payload: NotionPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "notion",
    title: payload.title,
    kind: payload.object,
    summary: `${payload.object} shared with the Mivlet connection`,
    provenance: `Notion · ${payload.workspace}`,
    freshness: payload.lastEditedTime ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.plainText ? { contentPreview: payload.plainText } : {}),
    providerMetadata: { workspace: payload.workspace, object: payload.object }
  };
}

export function shapeNotionSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("notion", query, limit);
}

export function mapNotionError(error: ProviderErrorLike) {
  return classifyConnectorError("notion", error);
}
