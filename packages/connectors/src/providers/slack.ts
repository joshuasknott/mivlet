import type { ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface SlackPayload {
  id: string;
  kind: "conversation" | "message";
  channelId: string;
  channelName: string;
  text?: string;
  timestamp?: string;
}

export function normalizeSlackItem(payload: SlackPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "slack",
    title: payload.kind === "conversation" ? `#${payload.channelName}` : `#${payload.channelName} message`,
    kind: payload.kind,
    summary: payload.text ?? `Selected Slack ${payload.kind}`,
    provenance: `Slack · selected #${payload.channelName} conversation`,
    freshness: payload.timestamp ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.text ? { contentPreview: payload.text } : {}),
    providerMetadata: {
      channelId: payload.channelId,
      channelName: payload.channelName,
      ...(payload.timestamp ? { timestamp: payload.timestamp } : {})
    }
  };
}

export function shapeSlackSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("slack", query, limit);
}

export function prepareSlackDraft(channelId: string, text: string) {
  return prepareConnectorAction(
    "slack",
    "Slack",
    "slack.create-draft",
    { channelId, text, targetId: channelId },
    "medium",
    "Creates a local Slack message draft. It does not post the message."
  );
}

export function prepareSlackPost(channelId: string, text: string) {
  return prepareConnectorAction(
    "slack",
    "Slack",
    "slack.post",
    { channelId, text, targetId: channelId },
    "high",
    "Posts a message to the selected Slack conversation."
  );
}

export function mapSlackError(error: ProviderErrorLike) {
  return classifyConnectorError("slack", error);
}
