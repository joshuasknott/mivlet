import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("passes clean values through unchanged", () => {
    const result = redactSecrets("Prefers dark mode and a 4-day work week.");
    expect(result.refused).toBe(false);
    expect(result.safe).toBe("Prefers dark mode and a 4-day work week.");
  });

  it("refuses bearer / authorization / token markers", () => {
    for (const value of [
      "Bearer abc.def.ghi",
      "Authorization: Basic dXNlcjpwYXNz",
      "the access_token is xyz",
      "refresh_token=xyz",
      "client_secret=shhh"
    ]) {
      const result = redactSecrets(value);
      expect(result.refused, `expected refusal for: ${value}`).toBe(true);
    }
  });

  it("refuses password / secret / api-key markers", () => {
    for (const value of [
      "password=hunter2",
      "the secret is 12345",
      "api key: sk-test-123",
      "my API_KEY is abc"
    ]) {
      const result = redactSecrets(value);
      expect(result.refused, `expected refusal for: ${value}`).toBe(true);
    }
  });

  it("refuses known provider token shapes", () => {
    for (const value of [
      "ghp_01234567890abcdefghij",
      "github_pat_ABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghij",
      "xoxp-1234567890-abcdefghij"
    ]) {
      const result = redactSecrets(value);
      expect(result.refused, `expected refusal for: ${value}`).toBe(true);
    }
  });

  it("refuses AWS-style key prefixes", () => {
    const result = redactSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(result.refused).toBe(true);
  });

  it("refuses a JWT-shaped value", () => {
    // three base64url segments joined by dots, each long enough to look real
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4f";
    const result = redactSecrets(jwt);
    expect(result.refused).toBe(true);
  });

  it("never echoes the secret back in the safe value when refused", () => {
    const secret = "Bearer super-secret-value-12345";
    const result = redactSecrets(secret);
    expect(result.refused).toBe(true);
    expect(result.safe).not.toContain("super-secret-value-12345");
    expect(result.safe).not.toContain("Bearer");
  });

  it("is case-insensitive", () => {
    expect(redactSecrets("BEARER xyz").refused).toBe(true);
    expect(redactSecrets("My Password Is hunter2").refused).toBe(true);
  });

  it("does not refuse ordinary text that merely contains 'token' as a substring in a word", () => {
    // "tokenize" should not trip the token marker; the markers require word-ish
    // boundaries. "token=" or " token " patterns do trip.
    expect(redactSecrets("Let's tokenize the input.").refused).toBe(false);
  });
});
