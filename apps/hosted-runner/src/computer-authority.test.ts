import { describe, expect, it } from "vitest";
import {
  consumeCapabilityNonceRecord,
  isUniqueConstraintFailure,
  nextEnsureGeneration
} from "./capability-nonce";

describe("hosted computer generation", () => {
  it("starts at generation 1 and bumps whenever ensure sees a previous generation", () => {
    expect(nextEnsureGeneration(undefined)).toBe(1);
    expect(nextEnsureGeneration(1)).toBe(2);
    expect(nextEnsureGeneration(2)).toBe(3);
    expect(nextEnsureGeneration(7)).toBe(8);
  });
});

describe("hosted capability nonce ledger", () => {
  it("consumes a nonce once and rejects replay", () => {
    const rows = new Map<string, { expires_at: number; consumed_at: number }>();
    const exec = (query: string, ...params: Array<ArrayBuffer | string | number | null>) => {
      if (query.startsWith("DELETE")) {
        const now = Number(params[0]);
        for (const [nonce, row] of rows) {
          if (row.expires_at <= now) rows.delete(nonce);
        }
        return;
      }
      const nonce = String(params[0]);
      if (rows.has(nonce)) {
        throw new Error("UNIQUE constraint failed: consumed_nonces.nonce");
      }
      rows.set(nonce, { expires_at: Number(params[1]), consumed_at: Number(params[2]) });
    };

    consumeCapabilityNonceRecord(exec, "cap-first-nonce", 2_000, 1_000);
    expect(() => consumeCapabilityNonceRecord(exec, "cap-first-nonce", 2_000, 1_100)).toThrow("capability-replayed");
  });

  it("fails closed when the nonce store cannot write", () => {
    const exec = () => {
      throw new Error("disk is full");
    };
    expect(() => consumeCapabilityNonceRecord(exec, "cap-store-nonce", 2_000, 1_000))
      .toThrow("capability-store-unavailable");
  });

  it("recognizes SQLite unique-constraint failures", () => {
    expect(isUniqueConstraintFailure(new Error("UNIQUE constraint failed: consumed_nonces.nonce"))).toBe(true);
    expect(isUniqueConstraintFailure(new Error("SQLITE_CONSTRAINT"))).toBe(true);
    expect(isUniqueConstraintFailure(new Error("disk is full"))).toBe(false);
  });
});
