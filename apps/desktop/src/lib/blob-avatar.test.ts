import { describe, expect, it } from "vitest";
import { avatarVariant, createAvatarSeed } from "./blob-avatar";

describe("Robot agent portraits", () => {
  it("gives consecutive agents distinct family members and unique seeds", () => {
    const seeds = Array.from({ length: 8 }, () => createAvatarSeed());
    expect(new Set(seeds).size).toBe(8);
    expect(new Set(seeds.map(avatarVariant)).size).toBe(8);
  });
  it("restores the saved family member independently of creation order", () => {
    const before = avatarVariant("organic-v1:2:saved-agent");
    createAvatarSeed();
    expect(avatarVariant("organic-v1:2:saved-agent")).toBe(before);
    expect(before).toBe(2);
  });
  it("avoids silhouettes already in the workspace, including legacy seeds", () => {
    const used = Array.from({ length: 7 }, (_, i) => `rounded-v2:${i}:saved`);
    expect(createAvatarSeed(used)).toMatch(/^robot-v3:7:/);
    expect(createAvatarSeed(["organic-v1:0:saved"])).not.toMatch(/^robot-v3:0:/);
  });
  it("maps old or malformed seeds deterministically to SVG variants", () => {
    for (const [seed, savedVariant] of [["blob-v1:saved", 5], ["blob-v1:ava", 0], ["", 5], ['<script>https://example.com</script>', 6], ["organic-v1:99:invalid", 5]] as const) {
      const variant = avatarVariant(seed);
      expect(variant).toBe(savedVariant);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(8);
    }
  });
  it("keeps every explicit built-in variant stable across legacy seed formats", () => {
    expect(Array.from({ length: 8 }, (_, index) => avatarVariant(`robot-v3:${index}:saved`))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from({ length: 8 }, (_, index) => avatarVariant(`rounded-v2:${index}:saved`))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from({ length: 8 }, (_, index) => avatarVariant(`organic-v1:${index}:saved`))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
