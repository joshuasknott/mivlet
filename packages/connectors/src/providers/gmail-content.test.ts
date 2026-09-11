import { describe, expect, it, vi } from "vitest";
import type { ConnectorTokenSet } from "@fable/protocol";
import { createGmailAdapter } from "./gmail";
import {
  buildGmailDraft,
  boundedPreview,
  decodeGmailBodyData,
  encodeGmailRaw,
  GMAIL_MAX_DECODED_BODY_BYTES,
  GMAIL_PREVIEW_CHARACTERS,
  gmailHeaderValue,
  gmailTextContent,
  safeHeaderField,
  type GmailPartLike
} from "./gmail-content";

const tokens: ConnectorTokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send"
  ]
};

const common = {
  clientId: "google-client",
  redirectUri: "http://127.0.0.1:43123/callback"
};

function response(body: unknown, status = 200) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fetchInit(fetcher: unknown): RequestInit {
  const call = ((fetcher as { mock: { calls: unknown[] } }).mock.calls[0] ?? []) as [string, RequestInit?];
  return call[1] ?? {};
}

function fetchUrl(fetcher: unknown): string {
  const call = ((fetcher as { mock: { calls: unknown[] } }).mock.calls[0] ?? []) as [string, RequestInit?];
  return String(call[0]);
}

function b64(text: string): string {
  return encodeGmailRaw(text);
}

function part(mimeType: string, data: string, extra: Partial<GmailPartLike> = {}): GmailPartLike {
  return { mimeType, body: { data: b64(data) }, ...extra };
}

describe("Gmail content helpers", () => {
  it("encodes raw messages as unpadded base64url UTF-8", () => {
    const raw = encodeGmailRaw("To: a@example.com\r\nSubject: x\r\n\r\nhéllo");
    expect(raw).not.toMatch(/[+/=]/);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGmailBodyData(raw)).toBe("To: a@example.com\r\nSubject: x\r\n\r\nhéllo");
  });

  it("decodes Gmail body data: unpadded base64url, padded base64, and +/ alphabet", () => {
    expect(decodeGmailBodyData("aGVsbG8")).toBe("hello");
    expect(decodeGmailBodyData("aGVsbG8=")).toBe("hello");
    expect(decodeGmailBodyData("dGVzdA==")).toBe("test");
    // Standard base64 alphabet (+ and /) is tolerated like Gmail's own parser.
    expect(decodeGmailBodyData("YStiL2M=")).toBe("a+b/c");
    expect(decodeGmailBodyData(b64("Grüße 世界"))).toBe("Grüße 世界");
  });

  it("fails closed on invalid encodings instead of emitting mojibake", () => {
    expect(decodeGmailBodyData("not valid base64!!")).toBeUndefined();
    expect(decodeGmailBodyData("!!!!")).toBeUndefined();
    expect(decodeGmailBodyData("a")).toBeUndefined(); // padding of one
    // "secret" is alphabet-valid but decodes to non-UTF-8 bytes.
    expect(decodeGmailBodyData("secret")).toBeUndefined();
    expect(decodeGmailBodyData("")).toBeUndefined();
  });

  it("skips oversized body parts instead of buffering them", () => {
    const huge = "x".repeat(GMAIL_MAX_DECODED_BODY_BYTES + 1);
    expect(decodeGmailBodyData(b64(huge))).toBeUndefined();
    expect(decodeGmailBodyData(b64("small"))).toBe("small");
  });

  it("extracts a bounded plaintext preview from nested multipart payloads", () => {
    const payload: GmailPartLike = {
      mimeType: "multipart/mixed",
      parts: [
        part("multipart/alternative", "", {
          parts: [
            part("text/plain", "Plain body text"),
            part("text/html", "<p>HTML <b>body</b></p>")
          ]
        }),
        part("application/pdf", "PDFBYTES", { filename: "report.pdf" })
      ]
    };
    const preview = gmailTextContent(payload);
    expect(preview).toBe("Plain body text");
    expect(preview).not.toContain("<");
  });

  it("prefers text/plain over text/html alternatives across the whole tree", () => {
    const payload: GmailPartLike = {
      mimeType: "multipart/mixed",
      parts: [
        part("multipart/alternative", "", {
          parts: [part("text/html", "<p>HTML only</p>"), part("text/plain", "Plain wins")]
        }),
        part("text/plain", "Second plain part")
      ]
    };
    const preview = gmailTextContent(payload);
    expect(preview).toContain("Plain wins");
    expect(preview).toContain("Second plain part");
    expect(preview).not.toContain("HTML only");
  });

  it("never renders fetched HTML as trusted markup", () => {
    const payload: GmailPartLike = part(
      "text/html",
      '<script>window.location="https://evil.example"</script><p onclick="steal()">Hi</p><img src=x onerror=alert(1)>'
    );
    const preview = gmailTextContent(payload);
    expect(preview).not.toContain("<script");
    expect(preview).not.toContain("onclick");
    expect(preview).not.toContain("onerror");
    expect(preview).not.toContain("evil.example");
    expect(preview).toBe("Hi");
  });

  it("returns an empty preview for absent or untyped bodies", () => {
    expect(gmailTextContent(undefined)).toBe("");
    expect(gmailTextContent({})).toBe("");
    expect(gmailTextContent({ mimeType: "text/plain" })).toBe("");
    expect(gmailTextContent({ mimeType: "text/plain", body: {} })).toBe("");
    expect(gmailTextContent(part("multipart/alternative", "", { parts: [] }))).toBe("");
    // Binary attachment parts never contribute text.
    expect(gmailTextContent(part("image/png", "PNG", { filename: "a.png" }))).toBe("");
  });

  it("bounds previews to a fixed character limit", () => {
    const long = "a".repeat(GMAIL_PREVIEW_CHARACTERS + 10_000);
    expect(gmailTextContent(part("text/plain", long))).toHaveLength(GMAIL_PREVIEW_CHARACTERS);
    expect(boundedPreview(long).length).toBeLessThanOrEqual(GMAIL_PREVIEW_CHARACTERS);
    expect(boundedPreview(undefined)).toBe("");
  });

  it("finds headers case-insensitively and preserves Unicode values", () => {
    const payload: GmailPartLike = {
      headers: [
        { name: "Subject", value: "Grüße aus Köln 🎉" },
        { name: "from", value: "Sender <sender@example.com>" }
      ]
    };
    expect(gmailHeaderValue(payload, "subject")).toBe("Grüße aus Köln 🎉");
    expect(gmailHeaderValue(payload, "FROM")).toBe("Sender <sender@example.com>");
    expect(gmailHeaderValue(payload, "In-Reply-To")).toBeUndefined();
  });

  it("rejects CR/LF header injection in recipient, subject, threading fields", () => {
    expect(() => safeHeaderField("a@b.c", "recipient")).not.toThrow();
    for (const [field, value] of [
      ["recipient", "a@b.c\r\nBcc: attacker@evil.example"],
      ["recipient", "a@b.c\nBcc: attacker@evil.example"],
      ["subject", "Hi\r\nBcc: attacker@evil.example"],
      ["subject", "Hi\nX-Evil: 1"],
      ["In-Reply-To", "<1@x>\r\nBcc: attacker@evil.example"],
      ["thread id", "t1\r\nBcc: attacker@evil.example"]
    ] as const) {
      expect(() => safeHeaderField(value, field)).toThrow(/line breaks/);
    }
    expect(() => buildGmailDraft({ to: "a@b.c", subject: "Hi\r\nBcc: attacker@evil.example" })).toThrow(
      /line breaks/
    );
    expect(() => buildGmailDraft({ to: "a@b.c\r\nBcc: x@y.z", subject: "Hi" })).toThrow(/line breaks/);
    expect(() => buildGmailDraft({ to: "a@b.c", inReplyTo: "<1@x>\r\nBcc: y@z" })).toThrow(/line breaks/);
  });

  it("builds drafts with recipients, threading, and UTF-8 bodies intact", () => {
    const draft = buildGmailDraft({
      to: "Alice <alice@example.com>",
      subject: "Grüße 世界",
      body: "Héllo 👋",
      threadId: "thread-9",
      inReplyTo: "<msg-1@example.com>"
    }) as { message: { raw: string; threadId: string } };
    const raw = decodeGmailBodyData(draft.message.raw);
    expect(raw).toBe(
      'To: Alice <alice@example.com>\r\nSubject: Grüße 世界\r\nIn-Reply-To: <msg-1@example.com>\r\n\r\nHéllo 👋'
    );
    // Threading semantics: threadId rides on Draft.Message per the API contract.
    expect(draft.message.threadId).toBe("thread-9");
  });

  it("requires a recipient for draft construction", () => {
    expect(() => buildGmailDraft({ subject: "No recipient" })).toThrow(/recipient/);
    expect(() => buildGmailDraft({})).toThrow(/recipient/);
  });
});

describe("Gmail adapter content handling", () => {
  it("creates drafts through users/me/drafts with a safe base64url raw message", async () => {
    const fetcher = vi.fn(async () =>
      response({ id: "draft-1", message: { id: "msg-draft-1", threadId: "thread-1" } })
    );
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const result = await adapter.write(
      {
        capability: "gmail.create-draft",
        input: { to: "a@example.com", subject: "Plan", body: "Body" },
        target: "a@example.com",
        preview: "Draft",
        riskLevel: "medium"
      },
      tokens
    );
    expect(fetchUrl(fetcher)).toContain("/users/me/drafts");
    expect(fetchInit(fetcher).method).toBe("POST");
    const body = JSON.parse(String(fetchInit(fetcher).body)) as { message: { raw: string } };
    expect(decodeGmailBodyData(body.message.raw)).toBe("To: a@example.com\r\nSubject: Plan\r\n\r\nBody");
    expect(body.message.raw).not.toMatch(/[+/=]/);
    // Draft resource shape: top-level id is the draft, message.id the message.
    expect(result).toMatchObject({ id: "draft-1", message: { id: "msg-draft-1" } });
    expect(JSON.stringify(result)).not.toContain("raw");
    expect(JSON.stringify(result)).not.toContain("payload");
  });

  it("keeps send on users/me/messages/send with the caller's raw message", async () => {
    const fetcher = vi.fn(async () => response({ id: "sent-1", threadId: "thread-1" }));
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const raw = b64("To: a@example.com\r\nSubject: Go\r\n\r\nShip");
    await adapter.write(
      { capability: "gmail.send", input: { raw }, target: "a@example.com", preview: "Send", riskLevel: "high" },
      tokens
    );
    expect(fetchUrl(fetcher)).toContain("/users/me/messages/send");
    expect(JSON.parse(String(fetchInit(fetcher).body))).toEqual({ raw });
  });

  it("rejects a malicious draft recipient before provider egress", async () => {
    const fetcher = vi.fn(async () => response({ id: "draft-1" }));
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    await expect(
      adapter.write(
        {
          capability: "gmail.create-draft",
          input: { to: "a@example.com\r\nBcc: attacker@evil.example", subject: "Hi" },
          target: "a@example.com",
          preview: "Draft",
          riskLevel: "medium"
        },
        tokens
      )
    ).rejects.toThrow(/line breaks/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("extracts a bounded plaintext preview from payload parts and strips bodies", async () => {
    const fetcher = vi.fn(async () =>
      response({
        id: "msg-1",
        threadId: "thread-1",
        snippet: "P".repeat(2000),
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            part("text/plain", "Review attached."),
            part("text/html", "<script>alert(1)</script><p>HTML fallback</p>")
          ]
        },
        sizeEstimate: 4096
      })
    );
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "gmail.read", input: { messageId: "msg-1" } }, tokens);
    const serialized = JSON.stringify(result);
    expect(result.items[0]).toMatchObject({ id: "msg-1", contentPreview: "Review attached." });
    expect(result.items[0].snippet).toHaveLength(GMAIL_PREVIEW_CHARACTERS);
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("sizeEstimate");
    expect(serialized).not.toContain("<script");
    expect(serialized).not.toContain("HTML fallback");
  });

  it("keeps metadata reads body-free: no preview key when no body is present", async () => {
    const fetcher = vi.fn(async () =>
      response({
        id: "msg-2",
        threadId: "thread-2",
        snippet: "Quick sync",
        payload: { headers: [{ name: "Subject", value: "Sync" }] }
      })
    );
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "gmail.read", input: { messageId: "msg-2" } }, tokens);
    expect(fetchUrl(fetcher)).toContain("format=metadata");
    expect(result.items[0]).toMatchObject({ id: "msg-2", snippet: "Quick sync" });
    expect(result.items[0]).not.toHaveProperty("contentPreview");
  });
});