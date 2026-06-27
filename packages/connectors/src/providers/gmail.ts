import type { ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface GmailPayload {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  internalDate?: string;
  labels?: string[];
}

export function normalizeGmailItem(payload: GmailPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "gmail",
    title: payload.subject || "(No subject)",
    kind: "message",
    summary: `Message from ${payload.from}`,
    provenance: "Gmail · selected search result",
    freshness: payload.internalDate ?? "Provider freshness unavailable",
    trust: "untrusted",
    contentPreview: payload.snippet,
    providerMetadata: {
      threadId: payload.threadId,
      from: payload.from,
      labels: (payload.labels ?? []).join(",")
    }
  };
}

export function shapeGmailSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("gmail", query, limit);
}

export function prepareGmailDraft(payload: {
  to: string;
  subject: string;
  body: string;
}) {
  return prepareConnectorAction(
    "gmail",
    "Gmail",
    "gmail.create-draft",
    { ...payload, targetId: payload.to },
    "medium",
    "Creates an email draft. It does not send the email."
  );
}

export function prepareGmailSend(payload: {
  draftId: string;
  to: string;
  subject: string;
}) {
  return prepareConnectorAction(
    "gmail",
    "Gmail",
    "gmail.send",
    { ...payload, targetId: payload.draftId },
    "high",
    "Sends the selected email to external recipients."
  );
}

export function mapGmailError(error: ProviderErrorLike) {
  return classifyConnectorError("gmail", error);
}
