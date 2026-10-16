import { AGENT_COLOURS } from "./agent-colours";
export const AVATAR_SHAPES = ["Scout", "Pilot", "Wisp", "Patch", "Quill", "Mote"] as const;
export const AVATAR_COLOURS = AGENT_COLOURS.map(([, colour]) => colour);
let nextPortrait = Math.floor(Math.random() * AVATAR_SHAPES.length);

export function avatarVariant(seed: string) {
  const saved = /^ink-v1:([0-5]):/.exec(seed);
  if (saved) return Number(saved[1]);
  const legacy = /^(?:robot-v3|rounded-v2|organic-v1):([0-7]):/.exec(seed);
  if (legacy) return Number(legacy[1]) % AVATAR_SHAPES.length;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return (hash >>> 0) % AVATAR_SHAPES.length;
}

/** Prefer an unused character, retaining a stable saved identity after creation. */
export function createAvatarSeed(existingSeeds: readonly string[] = []) {
  const counts = AVATAR_SHAPES.map(() => 0);
  for (const seed of existingSeeds) counts[avatarVariant(seed)]++;
  const minimum = Math.min(...counts);
  let variant = nextPortrait;
  while (counts[variant] !== minimum) variant = (variant + 1) % AVATAR_SHAPES.length;
  nextPortrait = (variant + 1) % AVATAR_SHAPES.length;
  return `ink-v1:${variant}:${crypto.randomUUID()}`;
}
