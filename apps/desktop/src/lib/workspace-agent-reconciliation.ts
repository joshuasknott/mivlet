import type { MivletAgentProfile } from "@mivlet/protocol";

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Preserve edits made in settings while a native workspace action was saving.
 * Native changes win only when both writers changed the same field. Deletion
 * never resurrects a profile, and unrelated local edits remain pending. */
export function reconcileWorkspaceAgents(
  before: readonly MivletAgentProfile[],
  local: readonly MivletAgentProfile[],
  saved: readonly MivletAgentProfile[],
): { agents: MivletAgentProfile[]; conflict: boolean } {
  let conflict = false;
  const agents: MivletAgentProfile[] = [];
  for (const native of saved) {
    const base = before.find(agent => agent.id === native.id);
    const current = local.find(agent => agent.id === native.id);
    if (!base) {
      if (current && !equal(current, native)) conflict = true;
      agents.push(native);
      continue;
    }
    if (!current) {
      if (!equal(base, native)) {
        conflict = true;
        agents.push(native);
      }
      continue;
    }
    const merged = { ...native };
    for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
      if (key === "id") continue;
      const field = key as keyof MivletAgentProfile;
      if (equal(current[field], base[field])) continue;
      if (equal(native[field], base[field])) {
        Object.assign(merged, { [field]: current[field] });
      } else if (!equal(native[field], current[field])) {
        conflict = true;
      }
    }
    agents.push(merged);
  }
  for (const current of local) {
    if (saved.some(agent => agent.id === current.id)) continue;
    const base = before.find(agent => agent.id === current.id);
    if (!base) agents.push(current);
    else if (!equal(base, current)) conflict = true;
  }
  // Concurrent deletions can each leave one agent but together remove both.
  // Keep the native surviving roster so the workspace remains usable.
  if (agents.length === 0 && saved.length > 0) {
    return { agents: [...saved], conflict: true };
  }
  return { agents, conflict };
}
