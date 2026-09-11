import { describe, expect, it, vi } from "vitest";
import type { ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorWriteRequest } from "../sdk";
import { createGoogleCalendarAdapter } from "./google-calendar";

// Google uses public PKCE directly against accounts.google.com; the adapter
// supplies default auth base URLs, so only the OAuth client id + redirect uri
// are required. Tests never exercise real network.
const common = {
  clientId: "google-client",
  redirectUri: "http://127.0.0.1:43123/callback"
};

const tokens: ConnectorTokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  scopes: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.events"
  ]
};

function response(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fetchCall(fetcher: unknown, index = 0): [string, RequestInit?] {
  return ((fetcher as { mock: { calls: unknown[] } }).mock.calls[index] ?? []) as [string, RequestInit?];
}

function fetchUrl(fetcher: unknown, index = 0): string {
  return String(fetchCall(fetcher, index)[0]);
}

function fetchInit(fetcher: unknown, index = 0): RequestInit {
  return fetchCall(fetcher, index)[1] ?? {};
}

function bodyOf(fetcher: unknown, index = 0): Record<string, unknown> {
  const init = fetchInit(fetcher, index);
  const raw = typeof init.body === "string" ? init.body : "";
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function writeRequest(
  capability: string,
  input: Record<string, unknown>,
  target: string
): ConnectorWriteRequest {
  return {
    capability,
    input,
    target,
    preview: `preview ${target}`,
    riskLevel: "medium"
  };
}

const FIXED_NOW = "2026-06-01T12:00:00.000Z";

function calendarAdapter(fetcher: unknown) {
  return createGoogleCalendarAdapter({ ...common, fetch: fetcher as typeof fetch, now: () => new Date(FIXED_NOW) });
}

describe("Google Calendar event time shaping (write)", () => {
  it("preserves PATCH semantics for a title-only update", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    await calendarAdapter(fetcher).write(writeRequest("google-calendar.update-draft", {
      calendarId: "primary", eventId: "evt-1", title: "Renamed meeting"
    }, "evt-1"), tokens);
    expect(fetchInit(fetcher).method).toBe("PATCH");
    expect(bodyOf(fetcher)).toEqual({ summary: "Renamed meeting" });
  });

  it("allows updating one event boundary without resending unchanged fields", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    await calendarAdapter(fetcher).write(writeRequest("google-calendar.update-draft", {
      calendarId: "primary", eventId: "evt-1", end: "2026-06-01T11:00:00Z"
    }, "evt-1"), tokens);
    expect(bodyOf(fetcher)).toEqual({ end: { dateTime: "2026-06-01T11:00:00Z" } });
  });

  it("shapes timed events as { dateTime, timeZone } without local conversion", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.write(
      writeRequest(
        "google-calendar.create-draft",
        {
          calendarId: "primary",
          title: "Design review",
          start: "2026-06-01T09:00:00-07:00",
          end: "2026-06-01T10:00:00-07:00",
          timezone: "America/Los_Angeles"
        },
        "primary"
      ),
      tokens
    );
    expect(bodyOf(fetcher).start).toEqual({
      dateTime: "2026-06-01T09:00:00-07:00",
      timeZone: "America/Los_Angeles"
    });
    expect(bodyOf(fetcher).end).toEqual({
      dateTime: "2026-06-01T10:00:00-07:00",
      timeZone: "America/Los_Angeles"
    });
  });

  it("preserves a timed event spanning a daylight-saving transition verbatim", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.write(
      writeRequest(
        "google-calendar.create-draft",
        {
          calendarId: "primary",
          title: "DST crossing",
          start: "2026-03-08T09:00:00-05:00",
          end: "2026-03-08T10:30:00-04:00",
          timezone: "America/New_York"
        },
        "primary"
      ),
      tokens
    );
    // The adapter must never interpret or re-derive these instants in the
    // local/browser time zone; explicit offsets and the IANA zone pass through.
    expect(bodyOf(fetcher).start).toEqual({
      dateTime: "2026-03-08T09:00:00-05:00",
      timeZone: "America/New_York"
    });
    expect(bodyOf(fetcher).end).toEqual({
      dateTime: "2026-03-08T10:30:00-04:00",
      timeZone: "America/New_York"
    });
  });

  it("shapes all-day events as { date } and preserves the exclusive end date", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.write(
      writeRequest(
        "google-calendar.create-draft",
        {
          calendarId: "primary",
          title: "Offsite",
          start: "2026-06-01",
          end: "2026-06-02",
          timezone: "America/Los_Angeles"
        },
        "primary"
      ),
      tokens
    );
    // Date-only values are all-day events: { date }, never { dateTime }, and
    // the timeZone field has no significance for all-day events.
    expect(bodyOf(fetcher).start).toEqual({ date: "2026-06-01" });
    expect(bodyOf(fetcher).end).toEqual({ date: "2026-06-02" });
  });

  it("preserves multi-day all-day ranges without shifting the exclusive end date", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.write(
      writeRequest(
        "google-calendar.create-draft",
        {
          calendarId: "primary",
          title: "Conference",
          start: "2026-06-01",
          end: "2026-06-05"
        },
        "primary"
      ),
      tokens
    );
    expect(bodyOf(fetcher).start).toEqual({ date: "2026-06-01" });
    // Google end.date is exclusive; the adapter passes it through untouched.
    expect(bodyOf(fetcher).end).toEqual({ date: "2026-06-05" });
  });

  it("keeps all-day events all-day when updating (never downgrades them to dateTime)", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.write(
      writeRequest(
        "google-calendar.update-draft",
        {
          calendarId: "primary",
          eventId: "evt-1",
          title: "Renamed offsite",
          start: "2026-06-01",
          end: "2026-06-02"
        },
        "evt-1"
      ),
      tokens
    );
    expect(bodyOf(fetcher).start).toEqual({ date: "2026-06-01" });
    expect(bodyOf(fetcher).end).toEqual({ date: "2026-06-02" });
    expect(fetchInit(fetcher).method).toBe("PATCH");
  });

  it("fails closed before egress when start or end is missing", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.write(
        writeRequest(
          "google-calendar.create-draft",
          { calendarId: "primary", title: "No end", start: "2026-06-01T09:00:00-07:00" },
          "primary"
        ),
        tokens
      )
    ).rejects.toThrow(/requires both start and end/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed before egress when start/end mix an all-day date and a timed dateTime", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.write(
        writeRequest(
          "google-calendar.create-draft",
          {
            calendarId: "primary",
            title: "Mixed",
            start: "2026-06-01",
            end: "2026-06-01T09:00:00-07:00"
          },
          "primary"
        ),
        tokens
      )
    ).rejects.toThrow(/all-day or timed consistently/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed before egress when the timed end is not strictly after start", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.write(
        writeRequest(
          "google-calendar.create-draft",
          {
            calendarId: "primary",
            title: "Inverted",
            start: "2026-06-01T17:00:00-07:00",
            end: "2026-06-01T09:00:00-07:00"
          },
          "primary"
        ),
        tokens
      )
    ).rejects.toThrow(/end to be strictly after start/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the all-day exclusive end date is not strictly after start", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.write(
        writeRequest(
          "google-calendar.create-draft",
          {
            calendarId: "primary",
            title: "Empty day",
            start: "2026-06-01",
            end: "2026-06-01"
          },
          "primary"
        ),
        tokens
      )
    ).rejects.toThrow(/exclusive end/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed instead of silently dropping approved attendees", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.write(
        writeRequest(
          "google-calendar.create-draft",
          {
            calendarId: "primary",
            title: "Meeting",
            start: "2026-06-01T09:00:00-07:00",
            end: "2026-06-01T10:00:00-07:00",
            attendees: "alice@example.com,bob@example.com"
          },
          "primary"
        ),
        tokens
      )
    ).rejects.toThrow(/attendees/i);
    // The operation must not proceed without the approved attendees.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed instead of silently dropping approved recurrence", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.write(
        writeRequest(
          "google-calendar.create-draft",
          {
            calendarId: "primary",
            title: "Weekly",
            start: "2026-06-01T09:00:00-07:00",
            end: "2026-06-01T10:00:00-07:00",
            recurrence: "RRULE:FREQ=WEEKLY;COUNT=4"
          },
          "primary"
        ),
        tokens
      )
    ).rejects.toThrow(/recurrence/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Google Calendar read list shaping", () => {
  it("defaults a bare event list to upcoming events only (timeMin = now)", async () => {
    const fetcher = vi.fn(async () => response({ items: [], nextPageToken: "page-2" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.read(
      { capability: "calendar.read", input: { calendarId: "primary" } },
      tokens
    );
    const url = new URL(fetchUrl(fetcher));
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    // Deterministic "now" fixture, RFC3339 with an explicit UTC offset.
    expect(url.searchParams.get("timeMin")).toBe(FIXED_NOW);
  });

  it("respects caller-supplied timeMin/timeMax instead of overriding them", async () => {
    const fetcher = vi.fn(async () => response({ items: [] }));
    const adapter = calendarAdapter(fetcher);
    await adapter.read(
      {
        capability: "calendar.read",
        input: {
          calendarId: "primary",
          timeMin: "2026-06-01T00:00:00Z",
          timeMax: "2026-07-01T00:00:00Z"
        }
      },
      tokens
    );
    const url = new URL(fetchUrl(fetcher));
    expect(url.searchParams.get("timeMin")).toBe("2026-06-01T00:00:00Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-07-01T00:00:00Z");
  });

  it("fails closed before egress when a list bound is not RFC3339 with a time zone offset", async () => {
    const fetcher = vi.fn(async () => response({ items: [] }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.read(
        { capability: "calendar.read", input: { calendarId: "primary", timeMin: "2026-06-01" } },
        tokens
      )
    ).rejects.toThrow(/time zone offset/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed before egress when timeMax is not strictly after timeMin", async () => {
    const fetcher = vi.fn(async () => response({ items: [] }));
    const adapter = calendarAdapter(fetcher);
    await expect(
      adapter.read(
        {
          capability: "calendar.read",
          input: {
            calendarId: "primary",
            timeMin: "2026-07-01T00:00:00Z",
            timeMax: "2026-06-01T00:00:00Z"
          }
        },
        tokens
      )
    ).rejects.toThrow(/timeMax to be strictly after timeMin/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("walks nextPageToken cursors for pagination", async () => {
    const fetcher = vi.fn(async () => response({ items: [{ id: "evt-2" }], nextPageToken: "page-3" }));
    const adapter = calendarAdapter(fetcher);
    const result = await adapter.read(
      {
        capability: "calendar.read",
        input: { calendarId: "primary", timeMin: "2026-06-01T00:00:00Z" },
        cursor: "page-2"
      },
      tokens
    );
    const url = new URL(fetchUrl(fetcher));
    expect(url.searchParams.get("pageToken")).toBe("page-2");
    expect(result).toMatchObject({ nextCursor: "page-3" });
  });
});

describe("Google Calendar identifier encoding", () => {
  it("URL-encodes calendarId and eventId path segments", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    await adapter.read(
      {
        capability: "calendar.read",
        input: { calendarId: "user+tag@group.calendar.google.com", eventId: "evt/1#2" }
      },
      tokens
    );
    const url = new URL(fetchUrl(fetcher));
    expect(url.pathname).toBe(
      "/calendar/v3/calendars/user%2Btag%40group.calendar.google.com/events/evt%2F1%232"
    );
  });

  it("URL-encodes identifiers on create, update, cancel, and delete writes", async () => {
    const fetcher = vi.fn(async () => response({ id: "evt-1" }));
    const adapter = calendarAdapter(fetcher);
    const calendarId = "user+tag@group.calendar.google.com";
    const eventId = "evt/1#2";
    const encodedPath =
      "/calendar/v3/calendars/user%2Btag%40group.calendar.google.com/events/evt%2F1%232";

    await adapter.write(
      writeRequest(
        "google-calendar.create-draft",
        { calendarId, title: "T", start: "2026-06-01T09:00:00-07:00", end: "2026-06-01T10:00:00-07:00" },
        "new"
      ),
      tokens
    );
    expect(new URL(fetchUrl(fetcher, 0)).pathname).toBe(
      "/calendar/v3/calendars/user%2Btag%40group.calendar.google.com/events"
    );

    await adapter.write(
      writeRequest(
        "google-calendar.update-draft",
        { calendarId, eventId, title: "T", start: "2026-06-01T09:00:00-07:00", end: "2026-06-01T10:00:00-07:00" },
        eventId
      ),
      tokens
    );
    expect(new URL(fetchUrl(fetcher, 1)).pathname).toBe(encodedPath);

    await adapter.write(writeRequest("google-calendar.cancel-event", { calendarId, eventId }, eventId), tokens);
    expect(new URL(fetchUrl(fetcher, 2)).pathname).toBe(encodedPath);
    expect(fetchInit(fetcher, 2).method).toBe("PATCH");
    expect(bodyOf(fetcher, 2)).toEqual({ status: "cancelled" });

    await adapter.write(writeRequest("google-calendar.delete-event", { calendarId, eventId }, eventId), tokens);
    expect(new URL(fetchUrl(fetcher, 3)).pathname).toBe(encodedPath);
    expect(fetchInit(fetcher, 3).method).toBe("DELETE");
    expect(fetchInit(fetcher, 3).body).toBeUndefined();
  });
});

describe("Google Calendar recurring series and instance metadata (read)", () => {
  it("keeps recurring-series and cancelled-instance metadata intact", async () => {
    const fetcher = vi.fn(async () =>
      response({
        items: [
          {
            id: "evt-series",
            summary: "Weekly sync",
            status: "confirmed",
            recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
            start: { dateTime: "2026-06-01T09:00:00-07:00", timeZone: "America/Los_Angeles" },
            end: { dateTime: "2026-06-01T10:00:00-07:00", timeZone: "America/Los_Angeles" }
          },
          {
            id: "evt-series_20260615T160000Z",
            summary: "Weekly sync",
            status: "cancelled",
            recurringEventId: "evt-series",
            originalStartTime: { dateTime: "2026-06-15T09:00:00-07:00" },
            start: { dateTime: "2026-06-15T09:00:00-07:00", timeZone: "America/Los_Angeles" },
            end: { dateTime: "2026-06-15T10:00:00-07:00", timeZone: "America/Los_Angeles" }
          }
        ]
      })
    );
    const adapter = calendarAdapter(fetcher);
    const result = await adapter.read(
      { capability: "calendar.read", input: { calendarId: "primary", timeMin: "2026-06-01T00:00:00Z" } },
      tokens
    );
    // Series-level recurrence metadata survives; a cancelled instance keeps its
    // status and recurringEventId so series vs instance stays distinguishable.
    expect(result.items[0]).toMatchObject({ recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] });
    expect(result.items[1]).toMatchObject({
      status: "cancelled",
      recurringEventId: "evt-series",
      originalStartTime: { dateTime: "2026-06-15T09:00:00-07:00" }
    });
  });
});
