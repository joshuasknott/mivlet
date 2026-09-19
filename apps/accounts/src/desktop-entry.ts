/** Only the configured native OAuth client can continue through this page. */
export function desktopEntry(search: string, issuer: string, clientId: string) {
  const input = new URLSearchParams(search);
  const mode = input.get("mode");
  if (!issuer || !clientId || (mode !== "sign-in" && mode !== "sign-up"))
    throw new Error("Desktop account entry is not configured.");
  if (
    input.getAll("mode").length !== 1 ||
    input.getAll("authorization_url").length !== 1
  )
    throw new Error("Invalid desktop account request.");
  const trusted = new URL(issuer);
  const authorization = new URL(input.get("authorization_url") ?? "");
  const params = authorization.searchParams;
  const allowed = new Set([
    "client_id",
    "response_type",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "prompt",
  ]);
  if (
    trusted.protocol !== "https:" ||
    authorization.origin !== trusted.origin ||
    authorization.pathname !== "/oauth/authorize" ||
    authorization.username ||
    authorization.password ||
    authorization.hash ||
    [...params.keys()].some(
      (key) => !allowed.has(key) || params.getAll(key).length !== 1,
    ) ||
    params.get("client_id") !== clientId ||
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256" ||
    params.get("prompt") !== "consent" ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(params.get("state") ?? "")
  )
    throw new Error("Invalid desktop authorization request.");
  const callback = new URL(params.get("redirect_uri") ?? "");
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    !callback.port ||
    callback.pathname !== "/callback" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new Error("Invalid desktop callback.");
  return { mode, authorizationUrl: authorization.href } as const;
}

/** Explicit continuation is safe only after desktopEntry validates it. Both
 * modes preserve the same PKCE request when a person switches forms. */
export function desktopFormUrl(
  entry: ReturnType<typeof desktopEntry>,
  origin: string,
) {
  const url = new URL(`/${entry.mode}`, origin);
  // Clerk treats an OAuth URL in redirect_url as an immediate OAuth entry.
  // Keep it separate until the selected form completes authentication.
  url.searchParams.set("mode", entry.mode);
  url.searchParams.set("authorization_url", entry.authorizationUrl);
  return url.href;
}

export async function openDesktopEntry(
  destination: string,
  sessionId: string | undefined,
  signOut: (options: {
    sessionId: string;
    redirectUrl: string;
  }) => Promise<void>,
  navigate: (url: string) => void,
  authorizationUrl?: string,
) {
  if (sessionId && authorizationUrl) {
    navigate(authorizationUrl);
  } else if (sessionId) {
    await signOut({ sessionId, redirectUrl: destination });
  } else {
    navigate(destination);
  }
}

const CONTINUATION_KEY = "mivlet.desktop-continuation";
const MAX_AGE = 5 * 60 * 1000;
type ContinuationStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Verification and social callbacks can lose the custom query. Keep the
 * validated public PKCE request in this tab only, never tokens or credentials. */
export function desktopContinuation(
  search: string,
  issuer: string,
  clientId: string,
  storage: ContinuationStore,
  now = Date.now(),
) {
  const supplied = new URLSearchParams(search).has("authorization_url");
  try {
    const stored = storage.getItem(CONTINUATION_KEY);
    const previous = stored
      ? (JSON.parse(stored) as { search: string; createdAt: number })
      : null;
    const query = supplied ? search : previous?.search;
    if (!query) return null;
    const entry = desktopEntry(query, issuer, clientId);
    // Changing forms or reloading must not extend the native callback deadline.
    const same =
      previous &&
      new URLSearchParams(previous.search).get("authorization_url") ===
        entry.authorizationUrl;
    const createdAt = same || !supplied ? previous?.createdAt : now;
    if (
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      createdAt > now ||
      now - createdAt >= MAX_AGE
    ) {
      storage.removeItem(CONTINUATION_KEY);
      throw new Error(
        "This login request expired. Return to Mivlet and start again.",
      );
    }
    storage.setItem(
      CONTINUATION_KEY,
      JSON.stringify({ search: query, createdAt }),
    );
    return entry;
  } catch (error) {
    storage.removeItem(CONTINUATION_KEY);
    throw error;
  }
}

export function clearDesktopContinuation(storage: ContinuationStore) {
  storage.removeItem(CONTINUATION_KEY);
}
