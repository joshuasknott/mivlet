import type {
  ConnectorActionKind,
  ConnectorActionRequest,
  ConnectorImportRequest,
  ConnectorManifest,
  ConnectorSearchRequest,
  FirstWaveConnectorId
} from "@arden/protocol";
import { connectorFixtures } from "../fixtures";
import { prepareGitHubComment, prepareGitHubDraftPullRequest } from "./github";
import { prepareGmailDraft, prepareGmailSend } from "./gmail";
import {
  prepareGoogleCalendarCreate,
  prepareGoogleCalendarUpdate
} from "./google-calendar";
import { prepareSlackDraft, prepareSlackPost } from "./slack";
import {
  importConnectorSearchItem,
  searchConnectorFixtures
} from "./shared";
import { prepareVercelPromotion, prepareVercelRollback } from "./vercel";

export const FIRST_WAVE_CONNECTOR_IDS = [
  "github",
  "vercel",
  "google-drive",
  "notion",
  "gmail",
  "slack",
  "google-calendar"
] as const satisfies readonly FirstWaveConnectorId[];

export function listFirstWaveConnectors(): ConnectorManifest[] {
  const ids = new Set<string>(FIRST_WAVE_CONNECTOR_IDS);
  return connectorFixtures
    .filter((connector) => ids.has(connector.id))
    .map((connector) => connector as ConnectorManifest);
}

export function searchFixtureConnector(request: ConnectorSearchRequest) {
  return searchConnectorFixtures(request);
}

export function importFixtureConnectorItem(request: ConnectorImportRequest) {
  return importConnectorSearchItem(request);
}

export function prepareFixtureConnectorAction(
  action: ConnectorActionKind,
  payload: Record<string, string>
): ConnectorActionRequest {
  switch (action) {
    case "github.draft-pull-request":
      return prepareGitHubDraftPullRequest({
        repository: payload.repository ?? payload.targetId ?? "acme/arden",
        head: payload.head ?? "connector-wave",
        base: payload.base ?? "main",
        title: payload.title ?? "Connector wave"
      });
    case "github.comment":
      return prepareGitHubComment({
        repository: payload.repository ?? "acme/arden",
        targetId: payload.targetId ?? "fixture-issue",
        body: payload.body ?? "Prepared connector review comment."
      });
    case "vercel.promote":
      return prepareVercelPromotion(payload.targetId ?? "fixture-deployment");
    case "vercel.rollback":
      return prepareVercelRollback(payload.targetId ?? "fixture-deployment");
    case "gmail.create-draft":
      return prepareGmailDraft({
        to: payload.to ?? "recipient@example.invalid",
        subject: payload.subject ?? "Connector review",
        body: payload.body ?? "Prepared email draft."
      });
    case "gmail.send":
      return prepareGmailSend({
        draftId: payload.draftId ?? payload.targetId ?? "fixture-draft",
        to: payload.to ?? "recipient@example.invalid",
        subject: payload.subject ?? "Connector review"
      });
    case "slack.create-draft":
      return prepareSlackDraft(
        payload.channelId ?? payload.targetId ?? "C_FIXTURE",
        payload.text ?? "Prepared Slack draft."
      );
    case "slack.post":
      return prepareSlackPost(
        payload.channelId ?? payload.targetId ?? "C_FIXTURE",
        payload.text ?? "Prepared Slack message."
      );
    case "google-calendar.create-draft":
      return prepareGoogleCalendarCreate({
        calendarId: payload.calendarId ?? payload.targetId ?? "fixture-primary",
        title: payload.title ?? "Connector review",
        start: payload.start ?? "2026-07-01T10:00:00Z",
        end: payload.end ?? "2026-07-01T10:30:00Z"
      });
    case "google-calendar.update-draft":
      return prepareGoogleCalendarUpdate({
        calendarId: payload.calendarId ?? "fixture-primary",
        eventId: payload.eventId ?? payload.targetId ?? "fixture-event",
        title: payload.title ?? "Connector review",
        start: payload.start ?? "2026-07-01T10:00:00Z",
        end: payload.end ?? "2026-07-01T10:30:00Z"
      });
  }
}
