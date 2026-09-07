import { describe, expect, it } from "vitest";
import { blobAvatarDataUrl, createAvatarSeed } from "./blob-avatar";

describe("Rounded agent portraits", () => {
  it("gives consecutive agents distinct family members and unique seeds", () => {
    const seeds = Array.from({ length: 8 }, () => createAvatarSeed());
    expect(new Set(seeds).size).toBe(8);
    expect(new Set(seeds.map(blobAvatarDataUrl)).size).toBe(8);
  });
  it("restores the saved family member independently of creation order", () => {
    const before = blobAvatarDataUrl("organic-v1:2:saved-agent");
    createAvatarSeed();
    expect(blobAvatarDataUrl("organic-v1:2:saved-agent")).toBe(before);
    expect(before).toContain("rounded-2.png");
  });
  it("avoids silhouettes already in the workspace, including legacy seeds", () => {
    const used = Array.from({ length: 7 }, (_, i) => `rounded-v2:${i}:saved`);
    expect(createAvatarSeed(used)).toMatch(/^rounded-v2:7:/);
    expect(createAvatarSeed(["organic-v1:0:saved"])).not.toMatch(/^rounded-v2:0:/);
  });
  it("maps old or malformed seeds deterministically to bundled assets", () => {
    for (const seed of ["blob-v1:saved", "", '<script>https://example.com</script>', "organic-v1:99:invalid"]) {
      const source = blobAvatarDataUrl(seed);
      expect(source).toBe(blobAvatarDataUrl(seed));
      expect(source).toMatch(/rounded-[0-7]\.png/);
      expect(source).not.toMatch(/<script|example\.com|NaN|Infinity/);
    }
  });
});
