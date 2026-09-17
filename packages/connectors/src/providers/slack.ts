import type { ConnectorSearchItem } from "@mivlet/protocol";
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

export function prepareSlackPostDetailed(input: { account: string; workspace: string; channelId: string; channelName: string; text: string }) {
  return prepareConnectorAction("slack", "Slack", "slack.post", { account: input.account, workspace: input.workspace, channelId: input.channelId, channelName: input.channelName, targetId: input.channelId, text: input.text }, "high", "Posts a message to the selected Slack conversation.");
}

type SlackMutation = "slack.reply" | "slack.edit" | "slack.delete" | "slack.react-add" | "slack.react-remove";
const SLACK_POLICY: Record<SlackMutation, { risk: "high" | "critical"; consequence: string }> = {
  "slack.reply": { risk: "high", consequence: "Posts a reply to the selected Slack thread." },
  "slack.edit": { risk: "high", consequence: "Edits the selected Slack message." },
  "slack.delete": { risk: "critical", consequence: "Deletes the selected Slack message." },
  "slack.react-add": { risk: "high", consequence: "Adds the selected reaction to a Slack message." },
  "slack.react-remove": { risk: "high", consequence: "Removes the selected reaction from a Slack message." }
};

export function prepareSlackMutation(action: SlackMutation, input: { account: string; workspace: string; channelId: string; channelName: string; text?: string; timestamp?: string; threadTimestamp?: string; reaction?: string }) {
  const policy = SLACK_POLICY[action];
  return prepareConnectorAction("slack", "Slack", action, { account: input.account, workspace: input.workspace, channelId: input.channelId, channelName: input.channelName, targetId: input.channelId, text: input.text ?? "", timestamp: input.timestamp ?? "", threadTimestamp: input.threadTimestamp ?? "", reaction: input.reaction ?? "" }, policy.risk, policy.consequence);
}

export function mapSlackError(error: ProviderErrorLike) {
  return classifyConnectorError("slack", error);
}
