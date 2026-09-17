import { requireHttpClerkIdentity, type ConvexAuthReader } from "./convexAuth";

/** Sliding window for hosted capability minting at the HTTP gate. */
export const EXECUTION_CAPABILITY_MINT_WINDOW_MS = 60_000;
/** Per authenticated Clerk subject + claimed device. */
export const EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE = 30;
/**
 * Per authenticated Clerk subject across devices. Stops a session from
 * multiplying the per-device budget by rotating `deviceId` before the mint
 * path checks the device link.
 */
export const EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT = 60;
export const RATE_LIMITED_CODE = "rate-limited";

const MAX_KEY_PART = 256;
const MINT_WINDOWS_TABLE = "execution_capability_mint_windows";

export type MintWindowHits = {
  hits: number[];
};

export type MintWindowConsumeResult = {
  allowed: boolean;
  entry: MintWindowHits;
  retryAfterMs: number;
};

type MintWindowDoc = {
  _id: string;
  mintKey: string;
  hits: number[];
  updatedAt: number;
};

export type MintRateDb = {
  query: Function;
  insert: Function;
  patch: Function;
  delete: Function;
};

export function executionCapabilityMintKey(
  kind: "subject" | "subject-device",
  parts: { issuer: string; subject: string; deviceId?: string },
): string {
  const issuer = boundKeyPart(parts.issuer);
  const subject = boundKeyPart(parts.subject);
  if (kind === "subject") return `subject:${issuer}:${subject}`;
  return `subject-device:${issuer}:${subject}:${boundKeyPart(parts.deviceId ?? "")}`;
}

/**
 * Sliding window: keep timestamps inside `windowMs`, deny at `limit` without
 * recording the rejected hit, otherwise append `now`.
 */
export function trimSlidingWindow(
  entry: MintWindowHits | undefined,
  now: number,
  windowMs: number,
): number[] {
  return (entry?.hits ?? []).filter((stamp) => now - stamp < windowMs && stamp <= now);
}

export function consumeSlidingWindow(
  entry: MintWindowHits | undefined,
  now: number,
  limit: number,
  windowMs: number,
): MintWindowConsumeResult {
  const hits = trimSlidingWindow(entry, now, windowMs);
  if (hits.length >= limit) {
    const oldest = Math.min(...hits);
    return {
      allowed: false,
      entry: { hits },
      retryAfterMs: Math.max(0, oldest + windowMs - now),
    };
  }
  hits.push(now);
  return { allowed: true, entry: { hits }, retryAfterMs: 0 };
}

/**
 * Atomically consume subject and subject+device mint budgets. Identity comes
 * from Clerk on `ctx`, never from the caller. Throws `rate-limited` when either
 * window is exhausted so the HTTP gate cannot mint after a missed check.
 */
export async function consumeExecutionCapabilityMintBudget(
  ctx: ConvexAuthReader & { db: MintRateDb },
  args: { deviceId: string; now?: number },
): Promise<{ allowed: true }> {
  const identity = await requireHttpClerkIdentity(ctx);
  const now = args.now ?? Date.now();
  const issuer = identity.external.normalizedIssuer;
  const subject = identity.external.subject;
  const deviceId = args.deviceId;
  const windows = [
    {
      mintKey: executionCapabilityMintKey("subject", { issuer, subject }),
      limit: EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT,
    },
    {
      mintKey: executionCapabilityMintKey("subject-device", { issuer, subject, deviceId }),
      limit: EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE,
    },
  ];

  const loaded = [];
  for (const window of windows) {
    loaded.push({ ...window, ...(await loadMintWindow(ctx.db, window.mintKey)) });
  }

  const prepared = loaded.map((window) => {
    const trimmed = trimSlidingWindow({ hits: window.hits }, now, EXECUTION_CAPABILITY_MINT_WINDOW_MS);
    return { ...window, trimmed, allowed: trimmed.length < window.limit };
  });
  const allowed = prepared.every((window) => window.allowed);
  for (const window of prepared) {
    const hits = allowed ? [...window.trimmed, now] : window.trimmed;
    if (!window.doc && hits.length === 0) continue;
    await persistMintWindow(ctx.db, window.doc, window.mintKey, hits, now);
  }
  if (!allowed) {
    throw new Error(RATE_LIMITED_CODE);
  }
  return { allowed: true };
}

async function loadMintWindow(
  db: MintRateDb,
  mintKey: string,
): Promise<{ doc: MintWindowDoc | null; hits: number[] }> {
  const rows = (await db
    .query(MINT_WINDOWS_TABLE)
    .withIndex("by_mint_key", (q: { eq: (field: string, value: unknown) => unknown }) =>
      q.eq("mintKey", mintKey),
    )
    .collect()) as MintWindowDoc[];
  if (rows.length === 0) return { doc: null, hits: [] };
  const [primary, ...duplicates] = rows;
  const hits = rows.flatMap((row) => row.hits);
  for (const extra of duplicates) {
    await db.delete(extra._id);
  }
  return { doc: primary, hits };
}

async function persistMintWindow(
  db: MintRateDb,
  doc: MintWindowDoc | null,
  mintKey: string,
  hits: number[],
  now: number,
): Promise<void> {
  if (doc) {
    await db.patch(doc._id, { hits, updatedAt: now });
    return;
  }
  await db.insert(MINT_WINDOWS_TABLE, { mintKey, hits, updatedAt: now });
}

function boundKeyPart(value: string): string {
  return value.slice(0, MAX_KEY_PART);
}
