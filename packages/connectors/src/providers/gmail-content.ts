import type { JsonObject } from "./http";

/**
 * Gmail content helpers (RFC 5322/RFC 2045 MIME shaping and bounded previews).
 *
 * The adapter's read path deliberately requests `format=metadata` and strips
 * bodies, so these helpers only ever produce bounded plaintext previews from
 * whatever payload shape the API returns; decoded HTML is never treated as
 * trusted markup, and decoded text is data, never instructions. Draft
 * construction here is the encode-side mirror: header injection is rejected
 * up front and the raw message is always UTF-8 base64url per the Gmail API
 * contract (`raw` is "an RFC 2822 formatted and base64url encoded string").
 */

/** Bounded plaintext preview length in characters (mirrors connector item truncation). */
export const GMAIL_PREVIEW_CHARACTERS = 500;

/**
 * Per-part decode bound in bytes. Body parts larger than this cannot
 * contribute to a preview; they are skipped rather than buffered.
 */
export const GMAIL_MAX_DECODED_BODY_BYTES = 64 * 1024;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * UTF-8 -> base64url (RFC 4648 §5, unpadded) as required by the Gmail `raw`
 * field. The global `btoa` is unsuitable: it only accepts Latin-1 input and
 * emits padded standard base64 (`+`, `/`, `=`).
 */
export function encodeGmailRaw(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    encoded += BASE64_ALPHABET[b0 >> 2];
    encoded += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) continue;
    encoded += BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) continue;
    encoded += BASE64_ALPHABET[b2 & 0x3f];
  }
  return encoded;
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode a Gmail body `data` value (base64url, tolerating `=` padding and the
 * standard `+`/`/` alphabet) into UTF-8 text. Returns undefined when the
 * encoding is invalid or the decoded size exceeds `maxBytes` — the part then
 * contributes nothing to a preview instead of producing mojibake or unbounded
 * buffering.
 */
export function decodeGmailBodyData(
  data: string,
  maxBytes = GMAIL_MAX_DECODED_BODY_BYTES
): string | undefined {
  if (!data) return undefined;
  let cleaned = data.trim();
  const padding = cleaned.length % 4;
  if (padding === 1) return undefined;
  if (padding > 0) cleaned += "=".repeat(4 - padding);
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 4) {
    const chunk = cleaned.slice(i, i + 4);
    const values = chunk.split("").map((char) => {
      if (char === "=") return 0;
      const index = BASE64URL_ALPHABET.indexOf(char);
      if (index >= 0) return index;
      const standard = BASE64_ALPHABET.indexOf(char);
      if (standard >= 0) return standard;
      return -1;
    });
    if (values.some((value) => value < 0)) return undefined;
    bytes.push((values[0] << 2) | (values[1] >> 4));
    if (chunk[2] !== "=" && i + 2 < cleaned.length) bytes.push(((values[1] & 0x0f) << 4) | (values[2] >> 2));
    if (chunk[3] !== "=" && i + 3 < cleaned.length) bytes.push(((values[2] & 0x03) << 6) | values[3]);
  }
  if (bytes.length > maxBytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

/** Minimal shape of the Gmail MessagePart and Message resources we touch. */
export interface GmailPartLike {
  mimeType?: string;
  filename?: string;
  body?: { data?: string } | null;
  parts?: GmailPartLike[];
  headers?: GmailHeaderLike[];
}

export interface GmailHeaderLike {
  name?: string;
  value?: string;
}

/** Case-insensitive first-match header lookup; absent headers return undefined. */
export function gmailHeaderValue(part: GmailPartLike, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const match = (part.headers ?? []).find((header) => (header.name ?? "").toLowerCase() === wanted);
  return match ? match.value : undefined;
}

function isAttachment(part: GmailPartLike): boolean {
  return typeof part.filename === "string" && part.filename.length > 0;
}

function stripHtmlToText(html: string): string {
  // Plain-text approximation only. The result is data, never trusted markup.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bounded plaintext preview from a nested MIME payload. Prefers `text/plain`
 * parts across the whole tree; falls back to `text/html` only when no plain
 * alternative exists (tags stripped, never rendered). Attachments and
 * undecodable or oversized parts are skipped; absent bodies yield "".
 */
export function gmailTextContent(
  payload: GmailPartLike | undefined,
  limit = GMAIL_PREVIEW_CHARACTERS
): string {
  if (!payload) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPartLike): void => {
    if (isAttachment(part)) return;
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (Array.isArray(part.parts) && part.parts.length > 0) {
      for (const child of part.parts) walk(child);
      return;
    }
    if (!part.body || typeof part.body.data !== "string") return;
    const text = decodeGmailBodyData(part.body.data);
    if (text === undefined) return;
    if (mimeType.startsWith("text/html")) html.push(text);
    else if (mimeType.startsWith("text/plain")) plain.push(text);
  };
  walk(payload);
  const candidates = plain.length > 0 ? plain : html;
  let combined = "";
  for (const candidate of candidates) {
    if (combined.length >= limit) break;
    const remaining = limit - combined.length;
    combined += combined ? "\n\n" : "";
    combined += (plain.length > 0 ? candidate : stripHtmlToText(candidate)).slice(0, remaining);
  }
  return combined.slice(0, limit);
}

/** Bound any free-form text surfaced in search items or previews. */
export function boundedPreview(value: string | undefined, limit = GMAIL_PREVIEW_CHARACTERS): string {
  return (value ?? "").slice(0, limit);
}

/**
 * Reject CR/LF in any user-supplied value that lands in an RFC 5322 header
 * (or a thread id that would be echoed into the request). Header injection is
 * refused up front instead of producing a malformed or attacker-shaped raw
 * message.
 */
export function safeHeaderField(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Gmail ${field} must not contain line breaks.`);
  }
  return value;
}

export interface GmailDraftInput {
  to?: string;
  subject?: string;
  body?: string;
  threadId?: string;
  inReplyTo?: string;
}

/**
 * Build the `users.drafts.create` request body. Recipients keep their To:
 * header semantics, `threadId` files the draft into an existing thread
 * (`Draft.Message.threadId`), and `inReplyTo` emits the In-Reply-To header
 * that (with matching subject) satisfies Gmail's threading criteria. The raw
 * message is UTF-8 base64url. Creating a draft never sends mail.
 */
export function buildGmailDraft(input: GmailDraftInput): JsonObject {
  const to = input.to === undefined ? undefined : safeHeaderField(input.to.trim(), "recipient");
  if (!to) throw new Error("Gmail draft requires a recipient.");
  const subject = input.subject === undefined ? undefined : safeHeaderField(input.subject, "subject");
  const inReplyTo =
    input.inReplyTo === undefined ? undefined : safeHeaderField(input.inReplyTo, "In-Reply-To");
  const threadId =
    input.threadId === undefined ? undefined : safeHeaderField(input.threadId, "thread id");
  const headers = [`To: ${to}`];
  if (subject) headers.push(`Subject: ${subject}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  const message: JsonObject = {
    raw: encodeGmailRaw(`${headers.join("\r\n")}\r\n\r\n${input.body ?? ""}`)
  };
  if (threadId) message.threadId = threadId;
  return { message };
}