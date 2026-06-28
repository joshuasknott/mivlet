import type { ConnectorCapability, ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export const GOOGLE_CALENDAR_CAPABILITIES = [
  { id: "calendar.list", kind: "read", consequential: false, description: "List accessible calendars." },
  { id: "calendar.read", kind: "read", consequential: false, description: "Read events, attendees, and availability." },
  { id: "google-calendar.create-draft", kind: "write", consequential: true, description: "Create an approved event." },
  { id: "google-calendar.update-draft", kind: "write", consequential: true, description: "Update an approved event." },
  { id: "google-calendar.cancel-event", kind: "write", consequential: true, description: "Cancel an approved event." },
  { id: "google-calendar.delete-event", kind: "write", consequential: true, description: "Delete an approved event." }
] satisfies ConnectorCapability[];

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
  timezone?: string;
  location?: string;
  attendees?: string;
  recurrence?: string;
}) {
  return prepareConnectorAction(
    "google-calendar",
    "Google Calendar",
    "google-calendar.create-draft",
    { ...payload, targetId: payload.calendarId },
    "medium",
    "Creates a calendar event after Fable approval."
  );
}

export function prepareGoogleCalendarUpdate(payload: {
  calendarId: string;
  eventId: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
  location?: string;
  attendees?: string;
  recurrence?: string;
}) {
  return prepareConnectorAction(
    "google-calendar",
    "Google Calendar",
    "google-calendar.update-draft",
    { ...payload, targetId: payload.eventId },
    "medium",
    "Updates the selected calendar event after Fable approval."
  );
}

export function prepareGoogleCalendarDelete(payload: {
  calendarId: string;
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  timezone?: string;
}) {
  return prepareConnectorAction(
    "google-calendar",
    "Google Calendar",
    "google-calendar.delete-event",
    { ...payload, targetId: payload.eventId },
    "high",
    "Deletes or cancels the selected calendar event after explicit approval."
  );
}

export function prepareGoogleCalendarCancel(payload: {
  calendarId: string;
  eventId: string;
  title?: string;
}) {
  return prepareConnectorAction(
    "google-calendar",
    "Google Calendar",
    "google-calendar.cancel-event",
    { ...payload, targetId: payload.eventId },
    "high",
    "Cancels the selected calendar event after explicit approval."
  );
}

export function mapGoogleCalendarError(error: ProviderErrorLike) {
  return classifyConnectorError("google-calendar", error);
}
