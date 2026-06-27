import type { ConnectorSearchItem } from "@arden/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface GoogleCalendarPayload {
  id: string;
  kind: "calendar" | "event";
  title: string;
  calendarId: string;
  start?: string;
  end?: string;
  status?: string;
  description?: string;
}

export function normalizeGoogleCalendarItem(
  payload: GoogleCalendarPayload
): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "google-calendar",
    title: payload.title,
    kind: payload.kind,
    summary: payload.description ?? `Selected Google Calendar ${payload.kind}`,
    provenance: `Google Calendar · ${payload.calendarId}`,
    freshness: payload.start ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.description ? { contentPreview: payload.description } : {}),
    providerMetadata: {
      calendarId: payload.calendarId,
      ...(payload.start ? { start: payload.start } : {}),
      ...(payload.end ? { end: payload.end } : {}),
      ...(payload.status ? { status: payload.status } : {})
    }
  };
}

export function shapeGoogleCalendarSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("google-calendar", query, limit);
}

export function prepareGoogleCalendarCreate(payload: {
  calendarId: string;
  title: string;
  start: string;
  end: string;
}) {
  return prepareConnectorAction(
    "google-calendar",
    "Google Calendar",
    "google-calendar.create-draft",
    { ...payload, targetId: payload.calendarId },
    "medium",
    "Creates a calendar event after Arden approval."
  );
}

export function prepareGoogleCalendarUpdate(payload: {
  calendarId: string;
  eventId: string;
  title: string;
  start: string;
  end: string;
}) {
  return prepareConnectorAction(
    "google-calendar",
    "Google Calendar",
    "google-calendar.update-draft",
    { ...payload, targetId: payload.eventId },
    "medium",
    "Updates the selected calendar event after Arden approval."
  );
}

export function mapGoogleCalendarError(error: ProviderErrorLike) {
  return classifyConnectorError("google-calendar", error);
}
