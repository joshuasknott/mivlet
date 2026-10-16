import type { SidebarPreferences } from "@mivlet/protocol";

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  pinned: [], projectOrder: [], agentOrder: [],
  projectSort: "recent", agentSort: "recent",
  projectsCollapsed: false, agentsCollapsed: false,
};

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 160 && id.trim() === id;

/** Old snapshots default to recent activity. Ignore invalid or duplicate references. */
export function normalizeSidebarPreferences(value: unknown): SidebarPreferences {
  const input = value && typeof value === "object" ? value as Partial<SidebarPreferences> : {};
  const ids = (list: unknown): string[] => Array.isArray(list)
    ? [...new Set(list.filter(validId))].slice(0, 500) : [];
  const seen = new Set<string>();
  const pinned: SidebarPreferences["pinned"] = [];
  if (Array.isArray(input.pinned)) for (const item of input.pinned) {
    if (!item || !["project", "agent"].includes(item.kind) || !validId(item.id)) continue;
    const key = `${item.kind}:${item.id}`;
    if (!seen.has(key)) { pinned.push({ kind: item.kind, id: item.id }); seen.add(key); }
    if (pinned.length === 500) break;
  }
  return {
    pinned, projectOrder: ids(input.projectOrder), agentOrder: ids(input.agentOrder),
    projectSort: input.projectSort === "manual" ? "manual" : "recent",
    agentSort: input.agentSort === "manual" ? "manual" : "recent",
    projectsCollapsed: input.projectsCollapsed === true,
    agentsCollapsed: input.agentsCollapsed === true,
  };
}

/** Unknown/new items follow the saved manual order; ties keep their source order. */
export function orderSidebarItems<T extends { id: string }>(
  items: T[], mode: "recent" | "manual", order: string[], activity: ReadonlyMap<string, number>,
): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => mode === "manual"
    ? (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length)
    : (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0));
}

export function moveSidebarItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = [...items], target = index + direction;
  if (index >= 0 && target >= 0 && target < next.length)
    [next[index], next[target]] = [next[target], next[index]];
  return next;
}
