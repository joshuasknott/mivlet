import { describe, expect, it } from "vitest";
import {
  EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT,
  EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE,
  EXECUTION_CAPABILITY_MINT_WINDOW_MS,
  RATE_LIMITED_CODE,
  consumeExecutionCapabilityMintBudget,
  consumeSlidingWindow,
  executionCapabilityMintKey,
} from "./executionCapabilityMintRate";

type Doc = {
  _id: string;
  mintKey: string;
  hits: number[];
  updatedAt: number;
};

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];

  constructor(private readonly docs: Doc[]) {}

  withIndex(
    _index: string,
    build: (query: { eq: (field: string, value: unknown) => unknown }) => unknown,
  ) {
    const query = {
      eq: (field: string, value: unknown) => {
        this.filters.push([field, value]);
        return query;
      },
    };
    build(query);
    return this;
  }

  async collect() {
    return this.docs.filter((doc) =>
      this.filters.every(([field, value]) => doc[field as keyof Doc] === value),
    );
  }
}

function mintDb(rows: Doc[] = []) {
  let nextId = 1;
  const db = {
    query: (table: string) => {
      expect(table).toBe("execution_capability_mint_windows");
      return new FakeQuery(rows);
    },
    insert: async (_table: string, doc: Omit<Doc, "_id">) => {
      const _id = `mint:${nextId++}`;
      rows.push({ _id, ...doc });
      return _id;
    },
    patch: async (id: string, patch: Partial<Doc>) => {
      const doc = rows.find((row) => row._id === id);
      if (!doc) throw new Error("missing mint window");
      Object.assign(doc, patch);
    },
    delete: async (id: string) => {
      const index = rows.findIndex((row) => row._id === id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
  return { db, rows };
}

function ctx(
  db: ReturnType<typeof mintDb>["db"],
  identity: { subject: string; issuer: string } | null = {
    subject: "user_clerk",
    issuer: "https://clerk.example",
  },
) {
  return {
    auth: {
      getUserIdentity: async () =>
        identity
          ? {
              subject: identity.subject,
              issuer: identity.issuer,
              tokenIdentifier: `${identity.issuer}|${identity.subject}`,
            }
          : null,
    },
    db,
  };
}

describe("execution capability mint windows", () => {
  it("allows up to the limit then denies without recording the rejected hit", () => {
    let window: { hits: number[] } | undefined;
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      const result = consumeSlidingWindow(window, now + i, 3, 1_000);
      expect(result.allowed).toBe(true);
      window = result.entry;
    }
    const denied = consumeSlidingWindow(window, now + 3, 3, 1_000);
    expect(denied.allowed).toBe(false);
    expect(denied.entry.hits).toHaveLength(3);
    expect(denied.retryAfterMs).toBe(1_000 - 3);
  });

  it("drops hits that have left the window so minting can resume", () => {
    const first = consumeSlidingWindow({ hits: [100, 200, 300] }, 1_000, 3, 500);
    expect(first.allowed).toBe(true);
    expect(first.entry.hits).toEqual([1_000]);
  });

  it("ignores future timestamps so a corrupted window cannot add budget", () => {
    const result = consumeSlidingWindow({ hits: [5_000, 50] }, 100, 2, 1_000);
    expect(result.allowed).toBe(true);
    expect(result.entry.hits).toEqual([50, 100]);
  });

  it("separates Clerk subject keys from subject+device keys", () => {
    const parts = {
      issuer: "https://clerk.example",
      subject: "user_clerk",
      deviceId: "device_1",
    };
    expect(executionCapabilityMintKey("subject", parts)).toBe(
      "subject:https://clerk.example:user_clerk",
    );
    expect(executionCapabilityMintKey("subject-device", parts)).toBe(
      "subject-device:https://clerk.example:user_clerk:device_1",
    );
    expect(executionCapabilityMintKey("subject-device", { ...parts, deviceId: "device_2" })).not.toBe(
      executionCapabilityMintKey("subject-device", parts),
    );
  });
});

describe("consumeExecutionCapabilityMintBudget", () => {
  it("fails closed without Clerk identity and does not write a window", async () => {
    const { db, rows } = mintDb();
    await expect(
      consumeExecutionCapabilityMintBudget(ctx(db, null), { deviceId: "device_1", now: 1_000 }),
    ).rejects.toThrow("authentication-required");
    expect(rows).toEqual([]);
  });

  it("records subject and subject+device hits on the first allowed mint", async () => {
    const { db, rows } = mintDb();
    await expect(
      consumeExecutionCapabilityMintBudget(ctx(db), { deviceId: "device_1", now: 5_000 }),
    ).resolves.toEqual({ allowed: true });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.mintKey).sort()).toEqual([
      "subject-device:https://clerk.example:user_clerk:device_1",
      "subject:https://clerk.example:user_clerk",
    ]);
    expect(rows.every((row) => row.hits.length === 1 && row.hits[0] === 5_000)).toBe(true);
  });

  it("isolates devices until the per-subject budget is exhausted", async () => {
    const { db } = mintDb();
    const identity = ctx(db);
    for (let i = 0; i < EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE; i += 1) {
      await consumeExecutionCapabilityMintBudget(identity, {
        deviceId: "device_1",
        now: 10_000 + i,
      });
    }
    await expect(
      consumeExecutionCapabilityMintBudget(identity, { deviceId: "device_1", now: 10_500 }),
    ).rejects.toThrow(RATE_LIMITED_CODE);

    for (let i = 0; i < EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE; i += 1) {
      await consumeExecutionCapabilityMintBudget(identity, {
        deviceId: "device_2",
        now: 11_000 + i,
      });
    }
    await expect(
      consumeExecutionCapabilityMintBudget(identity, { deviceId: "device_2", now: 11_500 }),
    ).rejects.toThrow(RATE_LIMITED_CODE);
  });

  it("caps a subject across devices so rotating deviceId cannot amplify minting", async () => {
    const { db } = mintDb();
    const identity = ctx(db);
    const now = 20_000;
    for (let i = 0; i < EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT; i += 1) {
      await consumeExecutionCapabilityMintBudget(identity, {
        deviceId: `device_${i}`,
        now: now + i,
      });
    }
    await expect(
      consumeExecutionCapabilityMintBudget(identity, {
        deviceId: "device_overflow",
        now: now + EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT,
      }),
    ).rejects.toThrow(RATE_LIMITED_CODE);
  });

  it("does not consume a new hit when the window is already exhausted", async () => {
    const subjectKey = executionCapabilityMintKey("subject", {
      issuer: "https://clerk.example",
      subject: "user_clerk",
    });
    const pairKey = executionCapabilityMintKey("subject-device", {
      issuer: "https://clerk.example",
      subject: "user_clerk",
      deviceId: "device_1",
    });
    const now = 30_000;
    const { db, rows } = mintDb([
      {
        _id: "mint:subject",
        mintKey: subjectKey,
        hits: Array.from({ length: EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT }, (_, i) => now - i),
        updatedAt: now,
      },
      {
        _id: "mint:pair",
        mintKey: pairKey,
        hits: Array.from(
          { length: EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE },
          (_, i) => now - i,
        ),
        updatedAt: now,
      },
    ]);
    await expect(
      consumeExecutionCapabilityMintBudget(ctx(db), { deviceId: "device_1", now: now + 10 }),
    ).rejects.toThrow(RATE_LIMITED_CODE);
    expect(rows.find((row) => row._id === "mint:subject")?.hits).toHaveLength(
      EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT,
    );
    expect(rows.find((row) => row._id === "mint:pair")?.hits).toHaveLength(
      EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE,
    );
  });

  it("merges duplicate window rows conservatively before consuming", async () => {
    const pairKey = executionCapabilityMintKey("subject-device", {
      issuer: "https://clerk.example",
      subject: "user_clerk",
      deviceId: "device_1",
    });
    const now = 40_000;
    const { db, rows } = mintDb([
      {
        _id: "mint:dup-a",
        mintKey: pairKey,
        hits: Array.from({ length: 20 }, (_, i) => now + i),
        updatedAt: now,
      },
      {
        _id: "mint:dup-b",
        mintKey: pairKey,
        hits: Array.from({ length: 20 }, (_, i) => now + 100 + i),
        updatedAt: now,
      },
    ]);
    await expect(
      consumeExecutionCapabilityMintBudget(ctx(db), { deviceId: "device_1", now: now + 200 }),
    ).rejects.toThrow(RATE_LIMITED_CODE);
    const remaining = rows.filter((row) => row.mintKey === pairKey);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.hits).toHaveLength(40);
    await expect(
      consumeExecutionCapabilityMintBudget(ctx(db), { deviceId: "device_1", now: now + 201 }),
    ).rejects.toThrow(RATE_LIMITED_CODE);
  });

  it("keeps distinct Clerk subjects on independent budgets", async () => {
    const { db } = mintDb();
    const first = ctx(db, { subject: "user_a", issuer: "https://clerk.example" });
    const second = ctx(db, { subject: "user_b", issuer: "https://clerk.example" });
    for (let i = 0; i < EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE; i += 1) {
      await consumeExecutionCapabilityMintBudget(first, { deviceId: "device_1", now: 50_000 + i });
    }
    await expect(
      consumeExecutionCapabilityMintBudget(first, { deviceId: "device_1", now: 50_500 }),
    ).rejects.toThrow(RATE_LIMITED_CODE);
    await expect(
      consumeExecutionCapabilityMintBudget(second, { deviceId: "device_1", now: 50_500 }),
    ).resolves.toEqual({ allowed: true });
  });

  it("exports a window long enough for a busy turn and short of unbounded minting", () => {
    expect(EXECUTION_CAPABILITY_MINT_WINDOW_MS).toBe(60_000);
    expect(EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT_DEVICE).toBe(30);
    expect(EXECUTION_CAPABILITY_MINT_LIMIT_PER_SUBJECT).toBe(60);
  });
});
