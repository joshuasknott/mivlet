/**
 * @vitest-environment node
 */

/**
 * Automated assertions over the Tauri CSP configuration.
 * These are build-time / config-time checks. They do not replace manual
 * validation of runtime webview behavior (onboarding flows, lazy chunk loads,
 * font/icon rendering, IPC, profile photo data: urls, optional Convex disabled).
 *
 * Production CSP must remain narrow. Dev uses separate config via --config.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function loadCsp(configPath: string) {
  const raw = readFileSync(configPath, "utf8");
  const conf = JSON.parse(raw);
  const csp = conf?.app?.security?.csp;
  return { conf, csp };
}



const desktopRoot = join(__dirname, "..", "..");
const prodConfigPath = join(desktopRoot, "src-tauri", "tauri.conf.json");
const devConfigPath = join(desktopRoot, "src-tauri", "tauri.dev.conf.json");

describe("tauri csp config (production)", () => {
  it("allows temporary voice playback without renderer network egress", () => {
    const { csp } = loadCsp(prodConfigPath);
    expect(csp["media-src"]).toBe("'self' blob:");
    expect(csp["connect-src"]).not.toMatch(/openai|https:/);
    expect(csp["script-src"]).toBe("'self'");
  });
  it("defines a production CSP (not null)", () => {
    const { csp } = loadCsp(prodConfigPath);
    expect(csp).toBeTruthy();
    expect(csp).not.toBeNull();
    expect(typeof csp).toBe("object");
  });

  it("rejects dangerous unrestricted defaults (null, *, unsafe-eval, bare external http/https, ws, broad hosts, external services)", () => {
    const { csp } = loadCsp(prodConfigPath);
    expect(csp).not.toBeNull();
    const cspStr = typeof csp === "string" ? csp : JSON.stringify(csp);
    // Explicitly reject null/empty/weak in prod
    expect(csp).not.toBeNull();
    expect(cspStr).not.toBe("null");
    // No wildcard or catch-all anywhere
    expect(cspStr).not.toMatch(/\*/);
    expect(cspStr).not.toMatch(/'\*'/);
    // No unsafe-eval
    expect(cspStr).not.toMatch(/unsafe-eval/i);
    // No bare external http/https wild or non-ipc (robust against suffixes like ipc.localhost.evil)
    expect(cspStr).not.toMatch(/https?:\/\/\*/);
    expect(cspStr).not.toMatch(/https?:\/\/(?!ipc\.localhost(?:[\s;"\']|$))/);
    // Also reject any http/https not exactly the allowed ipc token (covers suffix attacks)
    expect(cspStr).not.toMatch(/https?:\/\/ipc\.localhost(?!\b|[\s;"\']|$)/);
    // No ws: or broad dev hosts in prod
    expect(cspStr).not.toMatch(/\bws:/);
    expect(cspStr).not.toMatch(/127\.0\.0\.1:\*/);
    // No external services / providers
    expect(cspStr).not.toMatch(/convex|api\.|openai|anthropic|xai|googleapis|localhost:1420/i);
  });

  it("uses object form without forbidden broad patterns", () => {
    const { csp } = loadCsp(prodConfigPath);
    const cspStr = typeof csp === "string" ? csp : JSON.stringify(csp);
    expect(typeof csp).toBe("object");
    // No wildcard host or catch-all
    expect(cspStr).not.toMatch(/\*/);
    // No broad unsafe-eval in production
    expect(cspStr).not.toMatch(/unsafe-eval/i);
    // No bare http/https: * or external CDNs in webview policy
    expect(cspStr).not.toMatch(/https?:\/\/\*/);
  });

  it("contains the minimal required directives for Vite/Tauri prod assets + IPC + local resources", () => {
    const { csp } = loadCsp(prodConfigPath);
    expect(csp).toBeTypeOf("object");
    const cspObj = csp as Record<string, string | string[]>;
    expect(cspObj["default-src"]).toBeDefined();
    expect(cspObj["script-src"]).toBeDefined();
    expect(cspObj["connect-src"]).toBeDefined();
    expect(cspObj["font-src"]).toBeDefined();
    expect(cspObj["img-src"]).toBeDefined();
    expect(cspObj["style-src"]).toBeDefined();
    expect(cspObj["object-src"]).toBeDefined();
  });

  it("keeps connect-src limited to Tauri IPC (no webview network for providers/models/convex)", () => {
    const { csp } = loadCsp(prodConfigPath);
    const cspObj = csp as Record<string, string | string[]>;
    const connect = String(cspObj["connect-src"] || "").trim();
    expect(connect).toContain("ipc:");
    expect(connect).toContain("http://ipc.localhost");
    // Deterministic: the value must be exactly the evidenced tokens (prevents suffix / extra)
    const tokens = connect.split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(["ipc:", "http://ipc.localhost"]);
    // Must not include external services or broad ws or http in prod
    expect(connect).not.toMatch(/https?:\/\/(?!ipc\.localhost(?:[\s;"\']|$))/);
    expect(connect).not.toMatch(/\bws:/);
    expect(connect).not.toMatch(/convex|api\.|openai|anthropic|xai|googleapis/i);
  });

  it("allows only self + data: for fonts/images and unsafe-inline only for styles (Tauri nonces cover scripts)", () => {
    const { csp } = loadCsp(prodConfigPath);
    const cspObj = csp as Record<string, string | string[]>;
    const font = String(cspObj["font-src"] || "");
    const img = String(cspObj["img-src"] || "");
    const style = String(cspObj["style-src"] || "");
    const script = String(cspObj["script-src"] || "");
    const objectSrc = String(cspObj["object-src"] || "");
    expect(font).toMatch(/'self'/);
    expect(img).toMatch(/'self'/);
    expect(img).toMatch(/data:/);
    expect(style).toMatch(/'self'/);
    expect(style).toMatch(/'unsafe-inline'/);
    expect(script).toMatch(/'self'/);
    expect(objectSrc).toMatch(/'none'/);
  });

  it("explicitly allows only evidenced directives and no more in prod object", () => {
    const { csp } = loadCsp(prodConfigPath);
    const cspObj = csp as Record<string, string | string[]>;
    const allowed = Object.keys(cspObj).sort();
    // Voice playback uses temporary local media; no extra network/worker/frame directives.
    const expected = [
      "connect-src",
      "default-src",
      "font-src",
      "img-src",
      "media-src",
      "object-src",
      "script-src",
      "style-src"
    ].sort();
    expect(allowed).toEqual(expected);
  });

});

describe("tauri csp config (dev separation)", () => {
  it("provides a dev override via supported --config separation (does not weaken prod)", () => {
    const { csp: devCsp } = loadCsp(devConfigPath);
    const { csp: prodCsp } = loadCsp(prodConfigPath);
    expect(devCsp).toBeTruthy();
    expect(prodCsp).toBeTruthy();
    const devStr = typeof devCsp === "string" ? devCsp : JSON.stringify(devCsp);
    const prodStr = typeof prodCsp === "string" ? prodCsp : JSON.stringify(prodCsp);
    // Dev may need more (e.g. ws port wildcards + eval for HMR), but still no global '*" source
    expect(devStr).not.toContain("'*'");
    // Dev separation legitimately relaxes for Vite HMR (not present in prod)
    expect(devStr).toContain("unsafe-eval");
    expect(devStr).toContain("ws:");
    expect(devStr).toContain("127.0.0.1");
    // Prod must NOT have the dev-only relaxations
    expect(prodStr).not.toContain("unsafe-eval");
    expect(prodStr).not.toContain("ws:");
    expect(prodStr).not.toContain("127.0.0.1:1420");
    // Separation: dev and prod CSP strings differ
    expect(devStr).not.toBe(prodStr);
  });
});
