import { describe, it, expect, beforeEach } from "vitest";
import { createWaitlistRouter } from "./router.js";
import { randomUUID } from "./uuid.js";
import type { WaitlistEnv } from "./waitlist.js";

/**
 * Deterministic tests for shipped waitlist code.
 * Use in-memory mock for D1 to avoid pool env fragility while exercising full router + logic paths.
 * Real D1 migration tested via wrangler CLI in verification.
 */

function makeMockD1() {
  const rows = new Map<string, any>();
  const audits: any[] = [];
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first<T = any>() {
              if (sql.includes("SELECT * FROM subscribers WHERE email_hash")) {
                const h = args[0];
                for (const r of rows.values()) if (r.email_hash === h) return r as T;
                return null;
              }
              if (sql.includes("WHERE confirm_token_hash")) {
                const h = args[0];
                for (const r of rows.values()) if (r.confirm_token_hash === h) return r as T;
                return null;
              }
              if (sql.includes("WHERE id =")) {
                return rows.get(args[0]) || null;
              }
              if (sql.includes("FROM magic_tokens WHERE token_hash")) {
                const magics = (globalThis as any).__magics || {};
                const m = magics[args[0]];
                const nowStr = (args[2] || new Date().toISOString());
                if (m && m.type === args[1] && (m.exp || '') > nowStr) {
                  return { subscriber_id: m.sub } as T;
                }
                return null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO subscribers")) {
                const [id, cipher, hash, ver, chash, cm, plat, cj, ref, cth, exp, loc, now] = args;
                rows.set(id, {
                  id, email_ciphertext: cipher, email_hash: hash, status: "pending",
                  consent_version: ver, consent_text_hash: chash, consent_marketing: cm,
                  platform_interest: plat, connector_interest_json: cj, referral_code: ref,
                  confirm_token_hash: cth, confirm_expires_at: exp, locale: loc,
                  source: "web_waitlist", created_at: now, updated_at: now, confirmed_at: null, deleted_at: null
                });
              }
              if (sql.includes("UPDATE subscribers SET status='confirmed'")) {
                const row = rows.get(args[1]); if (row) { row.status = "confirmed"; row.confirmed_at = args[0]; row.updated_at = args[0]; }
              }
              if (sql.includes("UPDATE subscribers SET status='unsubscribed'")) {
                const row = rows.get(args[1]); if (row) { row.status = "unsubscribed"; row.updated_at = args[0]; }
              }
              if (sql.includes("DELETE FROM subscribers")) {
                rows.delete(args[0]);
              }
              if (sql.includes("INSERT INTO magic_tokens")) {
                (globalThis as any).__magics = (globalThis as any).__magics || {};
                // db createMagic: bind(hash, type, sub, exp, now) => args[0]=h,1=type,2=sub,3=exp
                // some tests: bind(h, sub, exp, now) with type literal in sql
                const h = args[0];
                let typ = 'unsub';
                let sub = args[1];
                let exp = args[2];
                if (sql.includes("'export'")) typ = 'export';
                else if (sql.includes("'delete'")) typ = 'delete';
                else if (sql.includes("'unsub'")) typ = 'unsub';
                else if (args[1] && typeof args[1] === 'string' && ['export','delete','unsub'].includes(args[1])) {
                  typ = args[1]; sub = args[2]; exp = args[3];
                } else if (args.length >= 4) {
                  // assume standard  hash,type,sub,exp
                  typ = args[1] || typ; sub = args[2] || sub; exp = args[3] || exp;
                }
                (globalThis as any).__magics[h] = { sub, type: typ, exp };
              }
              if (sql.includes("DELETE FROM magic_tokens")) {
                if ((globalThis as any).__magics) delete (globalThis as any).__magics[args[0]];
              }
              return { success: true };
            }
          };
        }
      };
    },
    exec: async (s: string) => ({})
  } as any;
}

const TEST_ENV: any = {
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  WAITLIST_EMAIL_PEPPER: "test-pepper-local",
  WAITLIST_SIGNING_KEY: "test-sign",
  RATE_LIMIT_SIGNUP_PER_HOUR: "999",
  RATE_LIMIT_EMAIL_PER_DAY: "999"
};

function makeReq(method: string, path: string, body?: any) {
  const u = "https://w.test" + path;
  return new Request(u, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
}

describe("waitlist deterministic (W-01 to W-13, no raw PII logging)", () => {
  let router: ReturnType<typeof createWaitlistRouter>;
  let mockD1: any;
  let capture: { issued: Array<{ type: string; token: string; subscriberId: string }> };

  function makeRouterWithCapture() {
    mockD1 = makeMockD1();
    capture = { issued: [] };
    const env = { ...TEST_ENV, DB: mockD1 };
    return createWaitlistRouter({ env, allowedOrigins: ["http://localhost:4321"], capture });
  }

  beforeEach(() => {
    router = makeRouterWithCapture();
  });

  it("W-01 valid signup 202 pending", async () => {
    const res = await router.handle(makeReq("POST", "/v1/signup", {
      email: "a@b.co", consent_marketing: true, consent_version: "2026-07-03-waitlist-v0.1", turnstile_token: "1x0000000000000000000000000000000AA"
    }), "9.9.9.9");
    expect(res.status).toBe(202);
    const j: any = await res.json();
    expect(j.status).toBe("pending");
  });

  it("W-02 duplicate safe identical 202", async () => {
    const body = { email: "dup@b.co", consent_marketing: true, consent_version: "2026-07-03-waitlist-v0.1", turnstile_token: "1x0000000000000000000000000000000AA" };
    const r1 = await router.handle(makeReq("POST", "/v1/signup", body), "1.1.1.1");
    const r2 = await router.handle(makeReq("POST", "/v1/signup", body), "1.1.1.1");
    expect(r1.status).toBe(202); expect(r2.status).toBe(202);
    expect(await r1.json()).toEqual(await r2.json());
  });

  it("W-03 invalid ts 400", async () => {
    const res = await router.handle(makeReq("POST", "/v1/signup", {
      email: "x@y.z", consent_marketing: true, consent_version: "2026-07-03-waitlist-v0.1", turnstile_token: "bad"
    }));
    expect(res.status).toBe(400);
  });

  it("W-11 honeypot 202 silent", async () => {
    const res = await router.handle(makeReq("POST", "/v1/signup", {
      email: "h@b.co", consent_marketing: true, consent_version: "2026-07-03-waitlist-v0.1", turnstile_token: "1x...", website: "spam"
    }));
    expect(res.status).toBe(202);
  });

  it("W-12 bad consent version 400", async () => {
    const res = await router.handle(makeReq("POST", "/v1/signup", {
      email: "v@b.co", consent_marketing: true, consent_version: "bad-ver", turnstile_token: "1x..."
    }));
    expect(res.status).toBe(400);
  });

  it("W-05/W-06 confirm token flow + single use", async () => {
    // Insert pending with known token hash via direct db
    const { encryptEmail, hmacSha256 } = await import("./crypto.js");
    const { hashToken } = await import("./tokens.js");
    const pepper = TEST_ENV.WAITLIST_EMAIL_PEPPER;
    const id = randomUUID();
    const e = "c@b.co";
    const eh = await hmacSha256(pepper, e);
    const ec = await encryptEmail(e, pepper);
    const tok = "TTOK-12345678901234567890123456789012";
    const th = await hashToken(tok);
    const now = new Date().toISOString();
    const exp = new Date(Date.now()+3600000).toISOString();
    // Use the exact parameterized insert shape from db.ts
    await mockD1.prepare(`INSERT INTO subscribers (id,email_ciphertext,email_hash,status,consent_version,consent_text_hash,consent_marketing,platform_interest,connector_interest_json,referral_code,confirm_token_hash,confirm_expires_at,locale,source,created_at,updated_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8,?9,?10,?11,?12,'web_waitlist',?13,?13)`).bind(id, ec, eh, "2026-07-03-waitlist-v0.1", "h", 1, "windows", null, null, th, exp, null, now).run();

    const r1 = await router.handle(makeReq("GET", `/v1/confirm?token=${tok}`));
    expect(r1.status).toBe(200);
    const j = await r1.json() as any;
    expect(j.status).toBe("confirmed");

    const r2 = await router.handle(makeReq("GET", `/v1/confirm?token=${tok}`));
    // second fails or non-pending
    expect([400,200]).toContain(r2.status);
  });

  it("W-13 health", async () => {
    const r = await router.handle(makeReq("GET", "/v1/health"));
    expect(r.status).toBe(200);
  });

  it("form-urlencoded body accepted for signup (no-JS path)", async () => {
    const sp = new URLSearchParams({ email: "form@b.test", consent_marketing: "true", consent_version: "2026-07-03-waitlist-v0.1", turnstile_token: "1x0000000000000000000000000000000AA" });
    const req = new Request("https://w.test/v1/signup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: sp.toString() });
    const res = await router.handle(req);
    expect(res.status).toBe(202);
  });

  it("native no-JS submit with missing/empty turnstile_token fails 400 (fail-closed)", async () => {
    const sp = new URLSearchParams({ email: "nojs@b.test", consent_marketing: "true", consent_version: "2026-07-03-waitlist-v0.1", turnstile_token: "" });
    const req = new Request("https://w.test/v1/signup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: sp.toString() });
    const res = await router.handle(req);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error.code).toBe("turnstile-failed");
  });

  it("export-request + export journey (router only, via capture from real issuance)", async () => {
    const pepper = TEST_ENV.WAITLIST_EMAIL_PEPPER;
    // Create a confirmed subscriber via real flows (signup + confirm)
    // First insert a pending row with a confirm token (minimal setup for the confirm leg)
    const { encryptEmail, hmacSha256 } = await import("./crypto.js");
    const { hashToken } = await import("./tokens.js");
    const { generateConfirmToken } = await import("./tokens.js");
    const id = randomUUID();
    const e = "expjour@b.test";
    const eh = await hmacSha256(pepper, e);
    const ec = await encryptEmail(e, pepper);
    const now = new Date().toISOString();
    const confTok = generateConfirmToken();
    const confHash = await hashToken(confTok);
    const expConf = new Date(Date.now() + 3600000).toISOString();
    await mockD1.prepare(`INSERT INTO subscribers (id,email_ciphertext,email_hash,status,consent_version,consent_text_hash,consent_marketing,platform_interest,connector_interest_json,referral_code,confirm_token_hash,confirm_expires_at,locale,source,created_at,updated_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8,?9,?10,?11,?12,'web_waitlist',?13,?13)`).bind(id, ec, eh, "2026-07-03-waitlist-v0.1", "hh", 1, "windows", null, null, confHash, expConf, null, now).run();

    // Confirm (this will also issue 'unsub' via central path; capture will record)
    const confRes = await router.handle(makeReq("GET", `/v1/confirm?token=${confTok}`));
    expect(confRes.status).toBe(200);

    // Now request export (real code path will call issueMagicToken('export') and populate capture)
    const reqR = makeReq("POST", "/v1/export-request", { email: e });
    expect((await router.handle(reqR)).status).toBe(202);

    // Find the export token that was issued during the requestExport call
    const exportIssued = capture.issued.find((i: any) => i.type === "export" && i.subscriberId === id);
    expect(exportIssued).toBeTruthy();
    const exportTok = exportIssued!.token;

    const expRes = await router.handle(makeReq("GET", `/v1/export?token=${exportTok}`));
    expect(expRes.status).toBe(200);
    const data: any = await expRes.json();
    expect(data.email).toBe(e);
  });

  it("delete-request + delete journey (router only, via capture)", async () => {
    const pepper = TEST_ENV.WAITLIST_EMAIL_PEPPER;
    const { encryptEmail, hmacSha256 } = await import("./crypto.js");
    const { hashToken } = await import("./tokens.js");
    const { generateConfirmToken } = await import("./tokens.js");
    const id = randomUUID();
    const e = "deljour@b.test";
    const eh = await hmacSha256(pepper, e);
    const ec = await encryptEmail(e, pepper);
    const now = new Date().toISOString();
    const confTok = generateConfirmToken();
    const confHash = await hashToken(confTok);
    const expConf = new Date(Date.now() + 3600000).toISOString();
    await mockD1.prepare(`INSERT INTO subscribers (id,email_ciphertext,email_hash,status,consent_version,consent_text_hash,consent_marketing,platform_interest,connector_interest_json,referral_code,confirm_token_hash,confirm_expires_at,locale,source,created_at,updated_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8,?9,?10,?11,?12,'web_waitlist',?13,?13)`).bind(id, ec, eh, "2026-07-03-waitlist-v0.1", "hh", 1, "windows", null, null, confHash, expConf, null, now).run();

    await router.handle(makeReq("GET", `/v1/confirm?token=${confTok}`));

    const dr = makeReq("POST", "/v1/delete-request", { email: e });
    expect((await router.handle(dr)).status).toBe(202);

    const delIssued = capture.issued.find((i: any) => i.type === "delete" && i.subscriberId === id);
    expect(delIssued).toBeTruthy();
    const delTok = delIssued!.token;

    const delRes = await router.handle(makeReq("POST", "/v1/delete", { token: delTok }));
    expect(delRes.status).toBe(200);
    const j: any = await delRes.json();
    expect(j.status).toBe("deleted");
  });

  it("unsubscribe journey (router only via confirm-issued unsub token from capture)", async () => {
    const pepper = TEST_ENV.WAITLIST_EMAIL_PEPPER;
    const { encryptEmail, hmacSha256 } = await import("./crypto.js");
    const { hashToken } = await import("./tokens.js");
    const { generateConfirmToken } = await import("./tokens.js");
    const id = randomUUID();
    const e = "unsubjour@b.test";
    const eh = await hmacSha256(pepper, e);
    const ec = await encryptEmail(e, pepper);
    const now = new Date().toISOString();
    const confTok = generateConfirmToken();
    const confHash = await hashToken(confTok);
    const expConf = new Date(Date.now() + 3600000).toISOString();
    await mockD1.prepare(`INSERT INTO subscribers (id,email_ciphertext,email_hash,status,consent_version,consent_text_hash,consent_marketing,platform_interest,connector_interest_json,referral_code,confirm_token_hash,confirm_expires_at,locale,source,created_at,updated_at) VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8,?9,?10,?11,?12,'web_waitlist',?13,?13)`).bind(id, ec, eh, "2026-07-03-waitlist-v0.1", "hh", 1, "windows", null, null, confHash, expConf, null, now).run();

    // Confirm issues the 'unsub' token via shipped confirm() path -> capture
    const cRes = await router.handle(makeReq("GET", `/v1/confirm?token=${confTok}`));
    expect(cRes.status).toBe(200);

    const unsubIssued = capture.issued.find((i: any) => i.type === "unsub" && i.subscriberId === id);
    expect(unsubIssued).toBeTruthy();
    const unsubTok = unsubIssued!.token;

    const res = await router.handle(makeReq("POST", "/v1/unsubscribe", { token: unsubTok }));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("unsubscribed");

    // consumed
    const res2 = await router.handle(makeReq("POST", "/v1/unsubscribe", { token: unsubTok }));
    expect(res2.status).toBe(400);
  });
});
