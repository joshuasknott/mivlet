/**
 * Barrel for the Fable-owned command layer.
 *
 * Pure parsing, secret redaction, and provider-neutral dispatch. No React, no
 * transport, no network — every function is fully unit-testable. The desktop
 * shell implements {@link CommandRuntime}; future backend families implement
 * the same seam so commands work uniformly across native API, Codex, ACP, and
 * Copilot.
 */

export { parseComposerText } from "./parse";
export { redactSecrets, type RedactionResult } from "./redact";
export {
  executeCommand,
  parseScheduleTrigger,
  type CommandRuntime,
  type ExecuteCommandOptions,
  type ScheduleCommandInput
} from "./dispatch";
