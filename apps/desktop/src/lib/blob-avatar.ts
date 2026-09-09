import { AGENT_COLOURS } from "./agent-colours";
import portrait0 from "../assets/agents/robot-0.png";
import portrait1 from "../assets/agents/robot-1.png";
import portrait2 from "../assets/agents/robot-2.png";
import portrait3 from "../assets/agents/robot-3.png";
import portrait4 from "../assets/agents/robot-4.png";
import portrait5 from "../assets/agents/robot-5.png";
import portrait6 from "../assets/agents/robot-6.png";
import portrait7 from "../assets/agents/robot-7.png";

const portraits = [portrait0, portrait1, portrait2, portrait3, portrait4, portrait5, portrait6, portrait7] as const;
export const AVATAR_SHAPES = ["Crest", "Lens", "Bob", "Fin", "Pods", "Hood", "Fold", "Square"] as const;
export const AVATAR_COLOURS = AGENT_COLOURS.map(([, colour]) => colour);
let nextPortrait = Math.floor(Math.random() * portraits.length);

export function avatarVariant(seed: string) {
  const saved = /^(?:robot-v3|rounded-v2|organic-v1):([0-7]):/.exec(seed);
  if (saved) return Number(saved[1]);
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return (hash >>> 0) % portraits.length;
}

/** Prefer an unused silhouette, retaining a stable saved identity after creation. */
export function createAvatarSeed(existingSeeds: readonly string[] = []) {
  const counts = portraits.map(() => 0);
  for (const seed of existingSeeds) counts[avatarVariant(seed)]++;
  const minimum = Math.min(...counts);
  let variant = nextPortrait;
  while (counts[variant] !== minimum) variant = (variant + 1) % portraits.length;
  nextPortrait = (variant + 1) % portraits.length;
  return `robot-v3:${variant}:${crypto.randomUUID()}`;
}

export function blobAvatarDataUrl(seed: string) {
  return portraits[avatarVariant(seed)];
}
