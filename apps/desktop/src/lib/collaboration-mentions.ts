/** The identity data the composer needs to address an existing workspace agent. */
export interface WorkspaceMentionAgent {
  id: string;
  name: string;
  avatarSeed?: string;
  iconColor?: string;
  iconImageDataUrl?: string;
}

interface WorkspaceMention {
  agentId: string;
  /** The text the user saw when the mention was inserted. */
  label: string;
  /** Stable persisted representation stored in the draft/message. */
  token: string;
  start: number;
  end: number;
}

export interface WorkspaceMentionResolution {
  recipientIds: string[];
  mentions: WorkspaceMention[];
  /** Invalid or ambiguous leading recipients. An error always fails closed. */
  errors: string[];
  /** The text after leading recipients, or null when the message is a reference only. */
  assignment: string | null;
  shouldExecute: boolean;
}

export function workspaceMentionToken(agent: Pick<WorkspaceMentionAgent, "id" | "name">) {
  const label = agent.name.replace(/[\\\]]/g, (character) => `\\${character}`);
  return `@[${label}](agent:${agent.id})`;
}

const stableMentionPattern = /@\[((?:\\.|[^\]])+)\]\(agent:([^\s)]+)\)/g;

function unescapeMentionLabel(label: string) {
  return label.replace(/\\([\\\]])/g, "$1");
}

/** Render persisted agent tokens for a conversation without changing storage. */
export function displayWorkspaceMentions(text: string) {
  return text.replace(stableMentionPattern, (_token, label: string) => `@${unescapeMentionLabel(label)}`);
}

function stableMentions(text: string, agents: readonly WorkspaceMentionAgent[]): WorkspaceMention[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const mentions: WorkspaceMention[] = [];
  for (const match of text.matchAll(stableMentionPattern)) {
    const agent = byId.get(match[2]);
    mentions.push({
      agentId: match[2],
      label: agent?.name ?? unescapeMentionLabel(match[1]),
      token: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return mentions;
}

/** Split stable workspace mentions for the contenteditable renderer. */
export function workspaceMentionParts(text: string, agents: readonly WorkspaceMentionAgent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const parts: { text: string; agent?: WorkspaceMentionAgent }[] = [];
  let end = 0;
  for (const match of text.matchAll(stableMentionPattern)) {
    const start = match.index ?? 0;
    const agent = byId.get(match[2]);
    if (!agent) continue;
    if (start > end) parts.push({ text: text.slice(end, start) });
    parts.push({ text: match[0], agent });
    end = start + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  if (!parts.length) return [{ text }];
  return parts;
}

function rawRecipientCandidates(
  text: string,
  agents: readonly WorkspaceMentionAgent[],
  referenceNames: readonly string[],
) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("@") || trimmed.startsWith("@[")) return null;
  const boundary = "(?=$|[\\s,;:!?])";
  const matches = agents.flatMap((agent) => [agent.name, agent.id].flatMap((label) => {
    if (!label.trim()) return [];
    const match = new RegExp(`^@${escapeRegExp(label)}${boundary}(?:\\s+|[,;:]\\s*|$)`, "iu").exec(trimmed);
    return match ? [{ agent, label, match }] : [];
  }));
  const referenceMatches = referenceNames.flatMap((label) => {
    if (!label.trim()) return [];
    const match = new RegExp(`^@${escapeRegExp(label)}${boundary}(?:\\s+|[,;:]\\s*|$)`, "iu").exec(trimmed);
    return match ? [{ label, match }] : [];
  });
  if (!matches.length) {
    if (referenceMatches.length) {
      const selected = referenceMatches.sort((left, right) => right.label.length - left.label.length)[0];
      return { query: selected.label, length: selected.match[0].length, candidates: [], reference: true };
    }
    const unknown = /^@([^\s,;:!?]+)/.exec(trimmed);
    return unknown ? { query: unknown[1], length: unknown[0].length, candidates: [] } : null;
  }
  const longest = Math.max(...matches.map(({ label }) => label.length));
  const candidates = [...new Map(matches.filter(({ label }) => label.length === longest).map(({ agent }) => [agent.id, agent])).values()];
  const selected = matches.find(({ label }) => label.length === longest)!;
  return { query: selected.label, length: selected.match[0].length, candidates, reference: false, referenceConflict: referenceMatches.some(match => match.label.length === longest) };
}

/**
 * Resolve workspace recipients without guessing. Only leading mentions followed
 * by non-empty assignment text can dispatch work; inline mentions and a name by
 * itself remain references. Stable picker tokens are always resolved by ID.
 */
export function resolveWorkspaceMentions(
  text: string,
  agents: readonly WorkspaceMentionAgent[],
  referenceNames: readonly string[] = [],
): WorkspaceMentionResolution {
  const stable = stableMentions(text, agents);
  const errors: string[] = [];
  const trimmed = text.trimStart();
  const startsInQuote = trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`") || trimmed.startsWith(">");
  const leading: WorkspaceMention[] = [];
  let cursor = text.length - trimmed.length;
  let remainder = trimmed;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  if (!startsInQuote) {
    while (remainder.startsWith("@")) {
      const stableMatch = /^@\[((?:\\.|[^\]])+)\]\(agent:([^\s)]+)\)(?:\s+|[,;:]\s*|$)/.exec(remainder);
      if (stableMatch) {
        const id = stableMatch[2];
        const token = stableMatch[0].trimEnd();
        const agent = byId.get(id);
        if (!agent) errors.push(`Agent “${unescapeMentionLabel(stableMatch[1])}” is no longer available.`);
        else leading.push({ agentId: id, label: agent.name, token, start: cursor, end: cursor + token.length });
        cursor += stableMatch[0].length;
        remainder = remainder.slice(stableMatch[0].length).trimStart();
        cursor = text.length - remainder.length;
        continue;
      }
      if (remainder.startsWith("@[")) {
        errors.push("Malformed workspace agent mention.");
        break;
      }
      const raw = rawRecipientCandidates(remainder, agents, referenceNames);
      if (!raw) break;
      if (raw.referenceConflict) {
        errors.push(`“@${raw.query}” names both an agent and a plugin. Select the agent from the picker.`);
        break;
      }
      if (raw.reference) {
        remainder = remainder.slice(raw.length).trimStart();
        cursor = text.length - remainder.length;
        continue;
      }
      if (raw.candidates.length !== 1) {
        errors.push(raw.candidates.length ? `“@${raw.query}” matches more than one agent.` : `Agent “@${raw.query}” was not found.`);
        break;
      }
      const agent = raw.candidates[0];
      const token = remainder.slice(0, raw.length).trimEnd();
      leading.push({ agentId: agent.id, label: agent.name, token, start: cursor, end: cursor + token.length });
      remainder = remainder.slice(raw.length).trimStart();
      cursor = text.length - remainder.length;
    }
  }

  const assignment = leading.length && remainder.trim() ? remainder.trim() : null;
  const recipientIds = [...new Set(leading.map((mention) => mention.agentId))];
  return {
    recipientIds,
    mentions: stable,
    errors,
    assignment,
    shouldExecute: leading.length > 0 && Boolean(assignment) && errors.length === 0,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
