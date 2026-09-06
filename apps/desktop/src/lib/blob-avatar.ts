import wedge from "../assets/agents/organic-wedge.png";
import branch from "../assets/agents/organic-branch.png";
import taper from "../assets/agents/organic-taper.png";
import bean from "../assets/agents/organic-bean.png";

const portraits = [wedge, branch, taper, bean] as const;
let nextPortrait = Math.floor(Math.random() * portraits.length);

/** Persist the family member so renaming never changes an identity. */
export function createAvatarSeed() {
  const variant = nextPortrait;
  nextPortrait = (nextPortrait + 1) % portraits.length;
  return `organic-v1:${variant}:${crypto.randomUUID()}`;
}

/** Legacy seeds receive a stable member of the approved Organic family. */
export function blobAvatarDataUrl(seed: string) {
  const saved = /^organic-v1:([0-3]):/.exec(seed);
  if (saved) return portraits[Number(saved[1])];
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return portraits[(hash >>> 0) % portraits.length];
}
