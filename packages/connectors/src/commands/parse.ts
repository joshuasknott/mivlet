/**
 * Provider-neutral parsing of composer text into a Fable command or a prompt.
 *
 * A command is recognized only when the first non-whitespace token starts with
 * `/` and is immediately followed by a known Fable command name, then either
 * end-of-text or a whitespace delimiter. A `/foo` that Fable does not own is
 * surfaced as `unknown-command` so the shell can treat it as ordinary prompt
 * text by default while reserving a seam for explicit backend passthrough.
 *
 * Pure: no React, no transport, no network. Kept here so the parser is fully
 * unit-testable and every backend family speaks the same command vocabulary.
 */

import {
  FABLE_COMMAND_TOKENS,
  type FableCommandName,
  type ParseCommandOutcome
} from "@fable/protocol";

const COMMAND_NAMES = FABLE_COMMAND_TOKENS.map((token) => token.slice(1));

/**
 * Parse raw composer text. Leading whitespace is tolerated; the command name
 * must be delimited from a longer word by whitespace or end-of-text.
 */
export function parseComposerText(text: string): ParseCommandOutcome {
  const natural = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (["stop current work", "cancel current work", "stop what you're doing", "stop what you are doing"].includes(natural)) {
    return { status: "command", request: { name: "stop", args: "" } };
  }
  if (!text.trimStart().startsWith("/")) {
    return { status: "prompt", text };
  }

  const leadTrimmed = text.trimStart();
  // A command name runs until the first whitespace.
  const firstSpace = leadTrimmed.search(/\s/);
  const token = firstSpace === -1 ? leadTrimmed : leadTrimmed.slice(0, firstSpace);
  const name = token.slice(1);

  if (COMMAND_NAMES.includes(name as FableCommandName)) {
    const args = firstSpace === -1 ? "" : leadTrimmed.slice(firstSpace).trim();
    return {
      status: "command",
      request: { name: name as FableCommandName, args }
    };
  }

  return { status: "unknown-command", token, text };
}
