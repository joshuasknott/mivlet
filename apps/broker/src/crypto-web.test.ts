/**
 * Tests for the Web Crypto helpers and endpoint templating. These guard the two
 * runtime-portability fixes: no Node `Buffer`/`node:crypto` in the broker core,
 * and the GitHub revocation `{clientId}` placeholder is always substituted.
 */

import { describe, expect, it } from "vitest";

import {
  base64,
  base64String,
  base64url,
  randomBytes,
  sha256
} from "./crypto-web.js";
import {
  providerProfile,
  resolveEndpoint,
  type ProviderCredentials
} from "./provider-profiles.js";
import { generatePkcePair } from "./pkce.js";

describe("web crypto helpers", () => {
  it("randomBytes returns the requested length with high entropy", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    // Two draws are effectively certain to differ.
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("base64 encodes bytes without a Node Buffer", () => {
    // "fable" -> base64 "ZmFibGU=" (RFC 4648 test vector spirit)
    const bytes = new TextEncoder().encode("fable");
    expect(base64(bytes)).toBe("ZmFibGU=");
  });

  it("base64String encodes a UTF-8 string (Basic-auth client:secret shape)", () => {
    expect(base64String("id:secret")).toBe(btoa("id:secret"));
  });

  it("base64url is unpadded URL-safe", () => {
    // bytes that would produce '+' and '/' in standard base64, plus padding.
    const bytes = new Uint8Array([0xff, 0xfb, 0xff, 0xff, 0xf0]);
    const url = base64url(bytes);
    expect(url).not.toMatch(/[+/=]/);
  });

  it("sha256 matches a known vector for the empty string", async () => {
    const empty = Array.from(await sha256(""));
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb924...
    expect(empty.slice(0, 4)).toEqual([0xe3, 0xb0, 0xc4, 0x42]);
  });
});

describe("PKCE over web crypto", () => {
  it("generatePkcePair produces a verifier + S256 challenge pair", async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
    // Challenge is the base64url SHA-256 of the verifier (not the verifier itself).
    expect(challenge).not.toEqual(verifier);
  });
});

describe("endpoint templating", () => {
  it("substitutes the GitHub {clientId} token deletion placeholder with the configured client id", () => {
    const creds: ProviderCredentials = { clientId: "client-123", clientSecret: "s" };
    expect(resolveEndpoint(providerProfile("github").revocationEndpoint, creds))
      .toBe("https://api.github.com/applications/client-123/token");
  });

  it("returns static endpoints unchanged (no placeholder)", () => {
    const creds: ProviderCredentials = { clientId: "x", clientSecret: "y" };
    for (const provider of ["vercel", "linear", "notion", "slack"] as const) {
      const resolved = resolveEndpoint(providerProfile(provider).revocationEndpoint, creds);
      expect(resolved).toBe(providerProfile(provider).revocationEndpoint);
      expect(resolved).not.toContain("{clientId}");
    }
  });

  it("never leaves a literal {clientId} in any resolved endpoint", () => {
    const creds: ProviderCredentials = { clientId: "abc", clientSecret: "def" };
    for (const provider of ["github", "vercel", "linear", "notion", "slack"] as const) {
      const resolved = resolveEndpoint(providerProfile(provider).revocationEndpoint, creds);
      expect(resolved).not.toContain("{clientId}");
    }
  });
});
