import { describe, expect, it } from "vitest";
import {
  looksLikeSecret,
  redactSecretText,
  SECRET_REDACTED,
  SECRET_REDACTION_CASES,
  secretMarkerSurvives
} from "@fable/protocol";
import { redactSecretsFromString } from "./redact";

describe("shared secret-redaction fixtures", () => {
  for (const fixture of SECRET_REDACTION_CASES) {
    it(`covers ${fixture.id}`, () => {
      expect(looksLikeSecret(fixture.input)).toBe(fixture.looksSecret);
      const redacted = redactSecretsFromString(fixture.input);
      expect(redacted).toBe(redactSecretText(fixture.input));
      for (const leaked of fixture.mustNotContain) {
        expect(redacted).not.toContain(leaked);
      }
      if (fixture.looksSecret) {
        expect(redacted === SECRET_REDACTED || !secretMarkerSurvives(redacted)).toBe(true);
      } else {
        expect(redacted).toBe(fixture.input);
        expect(secretMarkerSurvives(fixture.input)).toBe(false);
      }
    });
  }
});
