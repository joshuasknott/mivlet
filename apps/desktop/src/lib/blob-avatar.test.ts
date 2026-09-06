import { describe, expect, it } from "vitest";
import { blobAvatarDataUrl, createAvatarSeed } from "./blob-avatar";

describe("Organic agent portraits", () => {
  it("gives consecutive agents distinct family members and unique seeds", () => {
    const seeds = Array.from({ length: 4 }, () => createAvatarSeed());
    expect(new Set(seeds).size).toBe(4);
    expect(new Set(seeds.map(blobAvatarDataUrl)).size).toBe(4);
  });
  it("restores the saved family member independently of creation order", () => {
    const before = blobAvatarDataUrl("organic-v1:2:saved-agent");
    createAvatarSeed();
    expect(blobAvatarDataUrl("organic-v1:2:saved-agent")).toBe(before);
    expect(before).toContain("organic-taper.png");
  });
  it("maps old or malformed seeds deterministically to bundled assets", () => {
    for (const seed of ["blob-v1:saved", "", '<script>https://example.com</script>', "organic-v1:99:invalid"]) {
      const source = blobAvatarDataUrl(seed);
      expect(source).toBe(blobAvatarDataUrl(seed));
      expect(source).toMatch(/organic-(wedge|branch|taper|bean)\.png/);
      expect(source).not.toMatch(/<script|example\.com|NaN|Infinity/);
    }
  });
});
