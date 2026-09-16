/**
 * Rate-limiter log redaction. Handoff tickets, provider codes, and token-shaped
 * values must never survive {@link redactForLog}; operator logs are not a
 * second copy of the single-use ticket.
 */

import { describe, expect, it } from "vitest";

import {
  BROKER_LOG_REDACT_TICKET_KEYS,
  redactForLog
} from "./rate-limiter.js";

describe("redactForLog", () => {
  it("redacts handoff tickets from query strings and fragments", () => {
    const ticket = "live-handoff-ticket-value";
    const query = redactForLog(
      `GET /oauth/github/callback?handoff=${ticket}&state=desktop-state`
    );
    expect(query).not.toContain(ticket);
    expect(query).toContain("handoff=[redacted]");
    expect(query).toContain("state=desktop-state");

    const fragment = redactForLog(
      `http://127.0.0.1:43123/callback#handoff=${ticket}&state=desktop-state`
    );
    expect(fragment).not.toContain(ticket);
    expect(fragment).toContain("handoff=[redacted]");
  });

  it("redacts related ticket query keys and JSON ticket fields", () => {
    expect(BROKER_LOG_REDACT_TICKET_KEYS).toEqual(["handoff", "ticket"]);
    const alias = "live-ticket-alias-value";
    const aliased = redactForLog(`POST /oauth/github/handoff?ticket=${alias}`);
    expect(aliased).not.toContain(alias);
    expect(aliased).toContain("ticket=[redacted]");

    const jsonTicket = "json-handoff-ticket";
    const json = redactForLog(`{"handoff":"${jsonTicket}","ticket":"${alias}"}`);
    expect(json).not.toContain(jsonTicket);
    expect(json).not.toContain(alias);
    expect(json).toContain('"handoff":"[redacted]"');
    expect(json).toContain('"ticket":"[redacted]"');
  });

  it("redacts provider codes, bearer tokens, and JSON token fields", () => {
    const line = redactForLog(
      'GET /oauth/github/callback?code=provider-auth-code&access_token=atok Authorization: Bearer abc.def-ghi'
    );
    expect(line).not.toContain("provider-auth-code");
    expect(line).not.toContain("atok");
    expect(line).not.toContain("abc.def-ghi");
    expect(line).toContain("code=[redacted]");
    expect(line).toContain("access_token=[redacted]");
    expect(line).toContain("Bearer [redacted]");

    const body = redactForLog(
      '{"access_token":"secret-access","refresh_token":"secret-refresh","client_secret":"gh-secret","codeVerifier":"pkce-verifier"}'
    );
    expect(body).not.toContain("secret-access");
    expect(body).not.toContain("secret-refresh");
    expect(body).not.toContain("gh-secret");
    expect(body).not.toContain("pkce-verifier");
    expect(body).toContain('"access_token":"[redacted]"');
    expect(body).toContain('"refresh_token":"[redacted]"');
    expect(body).toContain('"client_secret":"[redacted]"');
    expect(body).toContain('"codeVerifier":"[redacted]"');
  });

  it("leaves non-secret request lines unchanged", () => {
    const line = "GET /healthz";
    expect(redactForLog(line)).toBe(line);
    expect(redactForLog("GET /oauth/github/authorize?state=desktop-state")).toContain(
      "state=desktop-state"
    );
  });
});
