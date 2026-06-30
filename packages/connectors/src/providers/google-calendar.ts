import type { ConnectorCapability, ConnectorSearchItem } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import {
  ProviderHttpClient,
  googleOAuthClient,
  isObject,
  page,
  stringValue,
  type FetchLike,
  type JsonObject,
  type OAuthClientOptions,
  type ProviderRequest
} from "./http";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";
import {
  googleConfigurationMessage,
  googleConnectorPermissions,
  googleScopeDescriptions,
  googleScopeIds
} from "./google-shared";

export const GOOGLE_CALENDAR_CAPABILITIES = [
  { id: "calendar.list", kind: "read", consequential: false, description: "List accessible calendars." },
  { id: "calendar.read", kind: "read", consequential: false, description: "Read events, attendees, and availability." },
  { id: "google-calendar.create-draft", kind: "write", consequential: true, description: "Create an approved event." },
  { id: "google-calendar.update-draft", kind: "write", consequential: true, description: "Update an approved event." },
  { id: "google-calendar.cancel-event", kind: "write", consequential: true, description: "Cancel an approved event." },
  { id: "google-calendar.delete-event", kind: "write", consequential: true, description: "Delete an approved event." }
] satisfies ConnectorCapability[];

export const GOOGLE_CALENDAR_OAUTH_SCOPES = googleScopeIds("google-calendar");
export const GOOGLE_CALENDAR_SCOPE_DESCRIPTIONS = googleScopeDescriptions("google-calendar");
export const GOOGLE_CALENDAR_PERMISSIONS = googleConnectorPermissions("google-calendar");
export const GOOGLE_CALENDAR_SETUP_MESSAGE = googleConfigurationMessage("google-calendar");

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

/**
 * Live Google Calendar adapter. Public-PKCE auth (no broker), per
 * `broker-contract.ts`. Reads map to the Calendar v3 REST surface and walk
 * `nextPageToken` cursors.
 *
 * Sync is conservative: list reads return calendar list / event metadata
 * (summary, time range, status, attendees' display info), and we always pass
 * `singleEvents=true` so recurring series expand sanely. Conference/video
 * details and extended gadget data are not requested.
 */
export interface GoogleCalendarAdapterOptions
  extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

export function createGoogleCalendarAdapter(
  options: GoogleCalendarAdapterOptions
): ConnectorAdapter<JsonObject, JsonObject> {
  const authBase = new URL(options.authBaseUrl ?? "https://accounts.google.com/");
  const auth = googleOAuthClient({
    ...options,
    connectorId: "google-calendar",
    authorizationEndpoint: new URL("o/oauth2/v2/auth", authBase).toString(),
    tokenEndpoint: new URL("o/oauth2/token", authBase).toString(),
    identityEndpoint: new URL("oauth2/v3/userinfo", authBase).toString(),
    revocationEndpoint: new URL("o/oauth2/revoke", authBase).toString(),
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
  });
  const http = new ProviderHttpClient(
    "google-calendar",
    options.apiBaseUrl ?? "https://www.googleapis.com/calendar/v3/",
    options.fetch
  );
  return {
    id: "google-calendar",
    capabilities: GOOGLE_CALENDAR_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      const mapped = googleCalendarReadRequest(request);
      const { data, response } = await http.request<unknown>(mapped, tokens);
      const items = isObject(data) && Array.isArray(data.items)
        ? data.items.map(redactCalendarObject)
        : isObject(data)
          ? [redactCalendarObject(data)]
          : [];
      return page(items, response, calendarNextCursor(data));
    },
    async write(request, tokens) {
      const { data } = await http.request<unknown>(googleCalendarWriteRequest(request), tokens);
      if (!isObject(data)) throw new Error("Google Calendar returned a malformed write response.");
      return redactCalendarObject(data);
    }
  };
}

function googleCalendarReadRequest(request: ConnectorRequest): ProviderRequest {
  const input = request.input;
  switch (request.capability) {
    case "calendar.list":
      return {
        path: "users/me/calendarList",
        signal: request.signal,
        query: { maxResults: bounded(input.limit), pageToken: request.cursor }
      };
    case "calendar.read": {
      // Single-event read when an eventId is supplied; otherwise list events
      // for the requested calendar. Defaults to upcoming events only so a
      // bare list call doesn't attempt to backfill entire histories.
      const eventId = optional(input, "eventId");
      if (eventId) {
        return {
          path: `calendars/${required(input, "calendarId")}/events/${eventId}`,
          signal: request.signal
        };
      }
      return {
        path: `calendars/${required(input, "calendarId")}/events`,
        signal: request.signal,
        query: {
          q: optional(input, "query"),
          maxResults: bounded(input.limit),
          pageToken: request.cursor,
          singleEvents: true,
          orderBy: "startTime",
          timeMin: optional(input, "timeMin"),
          timeMax: optional(input, "timeMax")
        }
      };
    }
    default:
      throw new Error(`Unsupported Google Calendar read capability: ${request.capability}`);
  }
}

function googleCalendarWriteRequest(request: ConnectorWriteRequest): ProviderRequest {
  const input = request.input;
  const calendarId = required(input, "calendarId");
  switch (request.capability) {
    case "google-calendar.create-draft":
      return { method: "POST", path: `calendars/${calendarId}/events`, body: eventBody(input), signal: request.signal };
    case "google-calendar.update-draft": {
      const eventId = required(input, "eventId");
      return { method: "PATCH", path: `calendars/${calendarId}/events/${eventId}`, body: eventBody(input), signal: request.signal };
    }
    case "google-calendar.cancel-event": {
      const eventId = required(input, "eventId");
      return { method: "PATCH", path: `calendars/${calendarId}/events/${eventId}`, body: { status: "cancelled" }, signal: request.signal };
    }
    case "google-calendar.delete-event": {
      const eventId = required(input, "eventId");
      return { method: "DELETE", path: `calendars/${calendarId}/events/${eventId}`, signal: request.signal };
    }
    default:
      throw new Error(`Unsupported Google Calendar write capability: ${request.capability}`);
  }
}

function eventBody(input: Record<string, unknown>): JsonObject {
  const body: JsonObject = {};
  const summary = optional(input, "title") ?? optional(input, "summary");
  if (summary) body.summary = summary;
  const description = optional(input, "description");
  if (description) body.description = description;
  const location = optional(input, "location");
  if (location) body.location = location;
  const start = optional(input, "start");
  const end = optional(input, "end");
  if (start) body.start = dateTime(start, optional(input, "timezone"));
  if (end) body.end = dateTime(end, optional(input, "timezone"));
  return body;
}

function dateTime(value: string, timezone?: string): JsonObject {
  // Google accepts { dateTime, timeZone } for timed events.
  return { dateTime: value, ...(timezone ? { timeZone: timezone } : {}) };
}

function redactCalendarObject(value: JsonObject): JsonObject {
  // Keep attendee display names but drop email addresses and any embedded
  // conference/hangout links so synced event metadata stays conservative.
  const copy = { ...value };
  for (const key of ["conferenceData", "gadget", "hangoutLink", "token", "apiKey"]) {
    delete copy[key];
  }
  const attendees = copy.attendees;
  if (Array.isArray(attendees)) {
    copy.attendees = attendees.map((attendee) => {
      if (isObject(attendee)) {
        const { email: _email, ...rest } = attendee;
        return rest;
      }
      return attendee;
    });
  }
  return copy;
}

function calendarNextCursor(data: unknown): string | undefined {
  const token = stringValue(data, "nextPageToken");
  return token && token.length > 0 ? token : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new Error(`Google Calendar capability requires ${key}.`);
  }
  return String(value);
}
function optional(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value ? value : undefined;
}
function bounded(value: unknown): number {
  return typeof value === "number" ? Math.max(1, Math.min(250, Math.floor(value))) : 50;
}
