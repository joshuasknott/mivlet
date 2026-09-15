import { redactSecretText, secretMarkerSurvives } from "@fable/protocol";

const OMITTED = "[output omitted: secret-shaped content]";

export function redactHostedProcessOutput(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactSecretText(value);
  if (secretMarkerSurvives(redacted)) return OMITTED;
  return redacted;
}
