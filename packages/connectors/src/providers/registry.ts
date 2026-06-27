import type {
  ConnectorActionKind,
  ConnectorActionRequest,
  ConnectorImportRequest,
  ConnectorManifest,
  ConnectorSearchRequest,
  FirstWaveConnectorId
} from "@fable/protocol";
import { connectorFixtures } from "../fixtures";
import { prepareGitHubComment, prepareGitHubDraftPullRequest } from "./github";
import { prepareGmailDraft, prepareGmailSend } from "./gmail";
import { prepareGoogleDriveAction } from "./google-drive";
import {
  prepareGoogleCalendarCreate,
  prepareGoogleCalendarDelete,
  prepareGoogleCalendarUpdate
} from "./google-calendar";
import { prepareNotionWrite } from "./notion";
import { prepareSlackDraft, prepareSlackMutation, prepareSlackPost } from "./slack";
import {
  importConnectorSearchItem,
  prepareConnectorAction,
  searchConnectorFixtures
} from "./shared";
import { prepareVercelPromotion, prepareVercelRollback } from "./vercel";
import { prepareLinearAction } from "./linear-actions";

export const FIRST_WAVE_CONNECTOR_IDS = [
  "github",
  "vercel",
  "google-drive",
  "notion",
  "gmail",
  "slack",
  "google-calendar",
  "linear"
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
        repository: payload.repository ?? payload.targetId ?? "acme/fable",
        head: payload.head ?? "connector-wave",
        base: payload.base ?? "main",
        title: payload.title ?? "Connector wave"
      });
    case "github.comment":
      return prepareGitHubComment({
        repository: payload.repository ?? "acme/fable",
        targetId: payload.targetId ?? "fixture-issue",
        body: payload.body ?? "Prepared connector review comment."
      });
    case "vercel.promote":
      return prepareVercelPromotion(payload.targetId ?? "fixture-deployment");
    case "vercel.rollback":
      return prepareVercelRollback(payload.targetId ?? "fixture-deployment");
    case "linear.create-issue":
    case "linear.update-issue":
    case "linear.comment":
      return prepareLinearAction(action, payload);
    case "github.create-issue":
    case "github.update-issue":
    case "github.create-review":
    case "github.update-file":
    case "github.create-branch":
    case "github.dispatch-workflow":
      return prepareConnectorAction("github", "GitHub", action, payload, "high", "Changes the identified GitHub repository resource after explicit approval.");
    case "vercel.create-deployment":
    case "vercel.cancel-deployment":
    case "vercel.update-project":
    case "vercel.create-domain":
    case "vercel.update-domain":
    case "vercel.delete-domain":
      return prepareConnectorAction("vercel", "Vercel", action, payload, "high", "Changes the identified Vercel team or project resource after explicit approval.");
    case "google-drive.create-file":
    case "google-drive.update-file":
    case "google-drive.move-file":
    case "google-drive.rename-file":
    case "google-drive.share-file":
    case "google-drive.delete-file":
      return prepareGoogleDriveAction(action, payload);
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
    case "slack.reply":
    case "slack.edit":
    case "slack.delete":
    case "slack.react-add":
    case "slack.react-remove":
      return prepareSlackMutation(action, {
        account: payload.account ?? "fixture-account",
        workspace: payload.workspace ?? "fixture-workspace",
        channelId: payload.channelId ?? payload.targetId ?? "C_FIXTURE",
        channelName: payload.channelName ?? "general",
        text: payload.text,
        timestamp: payload.timestamp ?? payload.targetId,
        threadTimestamp: payload.threadTimestamp,
        reaction: payload.reaction
      });
    case "notion.create-page":
    case "notion.update-page":
    case "notion.append-blocks":
    case "notion.update-block":
    case "notion.delete-block":
    case "notion.create-comment":
    case "notion.create-entry":
      return prepareNotionWrite(action, {
        workspace: payload.workspace ?? "fixture-workspace",
        targetId: payload.targetId ?? "fixture-target",
        destination: payload.destination ?? payload.targetId ?? "fixture-target",
        body: parseNotionBody(payload.body, payload.title),
        changedProperties: payload.changedProperties?.split(",").map((value) => value.trim()).filter(Boolean)
      });
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
    case "google-calendar.delete-event":
      return prepareGoogleCalendarDelete({
        calendarId: payload.calendarId ?? "fixture-primary",
        eventId: payload.eventId ?? payload.targetId ?? "fixture-event",
        title: payload.title
      });
    default:
      throw new Error(`Fixture connector action is not supported: ${action}`);
  }
}

function parseNotionBody(body: string | undefined, title: string | undefined) {
  if (!body) return { title: title ?? "Connector review" };
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { content: body };
  }
}
