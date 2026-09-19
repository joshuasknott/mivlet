import { describe, expect, it, vi } from "vitest";
import {
  desktopEntry,
  desktopFormUrl,
  openDesktopEntry,
} from "./desktop-entry";

const issuer = "https://clerk.example.test";
function request(mode = "sign-up", change?: (url: URL) => void) {
  const authorization = new URL(`${issuer}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    client_id: "desktop",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:54321/callback",
    scope: "openid profile email offline_access",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();
  change?.(authorization);
  return new URLSearchParams({
    mode,
    authorization_url: authorization.href,
  }).toString();
}

describe("desktop account entry", () => {
  it("ends only the active browser session before continuing to the requested form", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    await openDesktopEntry(
      "https://accounts.example.test/sign-up",
      "active-session",
      signOut,
      navigate,
    );
    expect(signOut).toHaveBeenCalledExactlyOnceWith({
      sessionId: "active-session",
      redirectUrl: "https://accounts.example.test/sign-up",
    });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("opens the form directly when the browser is already signed out", async () => {
    const signOut = vi.fn();
    const navigate = vi.fn();
    await openDesktopEntry(
      "https://accounts.example.test/sign-in",
      undefined,
      signOut,
      navigate,
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "https://accounts.example.test/sign-in",
    );
  });
  it("does not continue with a remembered identity when sign-out fails", async () => {
    const navigate = vi.fn();
    await expect(
      openDesktopEntry(
        "https://accounts.example.test/sign-up",
        "active-session",
        vi.fn().mockRejectedValue(new Error("offline")),
        navigate,
      ),
    ).rejects.toThrow("offline");
    expect(navigate).not.toHaveBeenCalled();
  });
  it.each(["sign-in", "sign-up"])(
    "routes %s with the exact native continuation",
    (mode) => {
      const entry = desktopEntry(request(mode), issuer, "desktop");
      const form = new URL(
        desktopFormUrl(entry, "https://accounts.example.test"),
      );
      expect(form.pathname).toBe(`/${mode}`);
      expect(form.searchParams.has("redirect_url")).toBe(false);
      expect(desktopEntry(form.search, issuer, "desktop")).toEqual(entry);
      expect(form.searchParams.get("authorization_url")).toBe(
        entry.authorizationUrl,
      );
      expect(new URL(entry.authorizationUrl).searchParams.get("prompt")).toBe(
        "consent",
      );
    },
  );
  it.each([
    (u: URL) => {
      u.hostname = "evil.test";
    },
    (u: URL) => {
      u.pathname = "/other";
    },
    (u: URL) => {
      u.username = "spoof";
    },
    (u: URL) => {
      u.searchParams.set("client_id", "other");
    },
    (u: URL) => {
      u.searchParams.set("redirect_uri", "https://evil.test/callback");
    },
    (u: URL) => {
      u.searchParams.set("redirect_uri", "http://127.0.0.1:54321/other");
    },
    (u: URL) => {
      u.searchParams.set("code_challenge_method", "plain");
    },
    (u: URL) => {
      u.searchParams.set("state", "short");
    },
    (u: URL) => {
      u.searchParams.append("client_id", "desktop");
    },
    (u: URL) => {
      u.searchParams.set("prompt", "none");
    },
    (u: URL) => {
      u.searchParams.set("login_hint", "other@example.test");
    },
  ])("rejects untrusted or weakened continuations", (change) => {
    expect(() =>
      desktopEntry(request("sign-up", change), issuer, "desktop"),
    ).toThrow();
  });
  it("fails closed on absent configuration, invalid mode, and duplicate entry parameters", () => {
    expect(() => desktopEntry(request(), "", "desktop")).toThrow();
    expect(() => desktopEntry(request("other"), issuer, "desktop")).toThrow();
    expect(() =>
      desktopEntry(`${request()}&mode=sign-in`, issuer, "desktop"),
    ).toThrow();
  });
});
