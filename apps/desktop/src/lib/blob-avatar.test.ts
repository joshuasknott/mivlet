import { describe, expect, it } from "vitest";
import { AVATAR_SHAPES, avatarVariant, createAvatarSeed } from "./blob-avatar";

describe("Ink character identities", () => {
  it("cycles through all six characters with unique saved identities", () => {
    const seeds = Array.from({ length: 6 }, () => createAvatarSeed());
    expect(new Set(seeds).size).toBe(6);
    expect(new Set(seeds.map(avatarVariant)).size).toBe(6);
    expect(seeds.every((seed) => seed.startsWith("ink-v1:"))).toBe(true);
  });
  it("restores every selected character independently of later creation", () => {
    for (let index = 0; index < AVATAR_SHAPES.length; index++) {
      createAvatarSeed();
      expect(avatarVariant(`ink-v1:${index}:saved`)).toBe(index);
    }
  });
  it("prefers an unused silhouette including migrated legacy identities", () => {
    const used = Array.from({ length: 5 }, (_, i) => `robot-v3:${i}:saved`);
    expect(createAvatarSeed(used)).toMatch(/^ink-v1:5:/);
    expect(createAvatarSeed(["organic-v1:0:saved"])).not.toMatch(/^ink-v1:0:/);
  });
  it("maps legacy and malformed seeds deterministically to a valid cell", () => {
    for (const seed of ["blob-v1:saved", "", "<script>bad</script>", "ink-v1:99:invalid", "robot-v3:7:saved"]) {
      const before = avatarVariant(seed);
      createAvatarSeed();
      expect(avatarVariant(seed)).toBe(before);
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(6);
    }
    for (const family of ["robot-v3", "rounded-v2", "organic-v1"]) {
      expect(Array.from({ length: 8 }, (_, index) => avatarVariant(`${family}:${index}:saved`))).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
    }
  });
});
