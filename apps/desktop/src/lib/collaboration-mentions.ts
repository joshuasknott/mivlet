import type { ConversationParticipant } from "@mivlet/protocol";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionPattern(name: string) {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_-])`,
    "iu",
  );
}

/**
 * Explicit @mentions address a named participant. Matching uses the durable
 * participant name (case-insensitive, longest name first) with a word boundary,
 * so an unknown token, an email address or a plugin mention never selects a
 * responder. The first mention in the text is the exact responder; every
 * mention is retained so the responder can see who was addressed.
 */
export function mentionedAgentIds(
  text: string,
  participants: ConversationParticipant[],
): string[] {
  const matches: { agentId: string; index: number; end: number }[] = [];
  for (const participant of participants) {
    const name = participant.name.trim();
    if (!name) continue;
    const match = mentionPattern(name).exec(text);
    if (match) {
      const index = match.index + match[1].length;
      matches.push({ agentId: participant.agentId, index, end: index + 1 + name.length });
    }
  }
  matches.sort((left, right) => left.index - right.index || right.end - left.end);
  const accepted: typeof matches = [];
  for (const match of matches) {
    if (accepted.some((other) => match.index < other.end && other.index < match.end))
      continue;
    accepted.push(match);
  }
  return accepted.map((match) => match.agentId);
}

export interface MentionResolution {
  /** The exact participant the message addresses; never an implicit fallback. */
  responderId: string;
  /** Every explicitly mentioned participant, in appearance order. */
  mentionedIds: string[];
}

/**
 * Resolve the responder for a send. A mention overrides the picked recipient,
 * and a coordinator is not consulted when someone else was named.
 */
export function resolveMentionResponder(
  text: string,
  participants: ConversationParticipant[],
): MentionResolution | null {
  const mentionedIds = mentionedAgentIds(text, participants);
  if (!mentionedIds.length) return null;
  return { responderId: mentionedIds[0], mentionedIds };
}

export interface ResponderSelection extends MentionResolution {
  source: "mention" | "selected" | "coordinator";
}

/**
 * Baseline responder selection. A mention wins, then the explicitly picked
 * participant, then the designated coordinator. Without any of those the send
 * fails closed instead of broadcasting to every member.
 */
export function selectResponder(
  text: string,
  participants: ConversationParticipant[],
  options: { selectedRecipientId?: string; coordinatorId?: string },
): ResponderSelection | null {
  const mentioned = resolveMentionResponder(text, participants);
  if (mentioned) return { ...mentioned, source: "mention" };
  const isParticipant = (id: string | undefined) =>
    Boolean(id) && participants.some((participant) => participant.agentId === id);
  if (isParticipant(options.selectedRecipientId))
    return {
      responderId: options.selectedRecipientId!,
      mentionedIds: [],
      source: "selected",
    };
  if (isParticipant(options.coordinatorId))
    return {
      responderId: options.coordinatorId!,
      mentionedIds: [],
      source: "coordinator",
    };
  return null;
}
