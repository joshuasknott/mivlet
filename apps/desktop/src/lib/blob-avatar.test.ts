import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blobAvatarDataUrl, createAvatarSeed } from "./blob-avatar";

describe("generated teammate portraits", () => {
  it("creates independent seeds and deterministic portraits without cycling a preset list", () => {
    const seeds = Array.from({ length: 1000 }, () => createAvatarSeed());
    expect(new Set(seeds).size).toBe(seeds.length);
    const portraits = seeds.map(blobAvatarDataUrl);
    expect(new Set(portraits).size).toBe(seeds.length);
    expect(seeds.map(blobAvatarDataUrl)).toEqual(portraits);
  });

  it("keeps the v1 design stable for a saved seed", () => {
    const portrait = blobAvatarDataUrl("blob-v1:fable-stable-portrait");
    expect(createHash("sha256").update(portrait).digest("hex")).toMatchInlineSnapshot(`"84b4658e213783aebcd1098ec5be5c723912a5b7a80995ba5a7bec21a9fada6a"`);
  });

  it("keeps seed contents out of generated markup", () => {
    const svg = decodeURIComponent(blobAvatarDataUrl('<script>external("https://example.com")</script>').split(",")[1]);
    expect(svg).not.toMatch(/<script|example\.com|onload|NaN|Infinity/);
    expect(svg).toContain('viewBox="0 0 64 64"');
  });
});
