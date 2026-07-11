const EMAIL_LOCAL_MAX = 64;
const EMAIL_DOMAIN_MAX = 253;
const EMAIL_TOTAL_MAX = 254;
const MAX_KEY_VERSIONS = 3;
const KEY_HEX = /^[a-f0-9]{64}$/u;
const VERSION = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/u;
const LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export const INVITATION_RECIPIENT_KEYRING_ENV = "FABLE_INVITATION_RECIPIENT_HMAC_KEYRING";

export interface InvitationRecipientKeyring {
  activeVersion: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export interface HashedInvitationEmail {
  attributeKind: "email";
  hashVersion: string;
  normalizedValueHash: string;
  displayHint: string;
}

export class InvitationRecipientUnavailableError extends Error {
  readonly code = "invitation-targeting-unavailable";

  constructor() {
    super("Verified-email invitations are unavailable in this build.");
  }
}

/** Conservative provider-neutral normalization. No dot or plus rewriting. */
export function normalizeInvitationEmail(value: unknown): string {
  if (typeof value !== "string") throw new InvitationRecipientUnavailableError();
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!normalized || normalized.length > EMAIL_TOTAL_MAX || /[^\x21-\x7e]/u.test(normalized)) {
    throw new InvitationRecipientUnavailableError();
  }
  const separator = normalized.indexOf("@");
  if (separator <= 0 || separator !== normalized.lastIndexOf("@")) throw new InvitationRecipientUnavailableError();
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (
    local.length > EMAIL_LOCAL_MAX
    || domain.length > EMAIL_DOMAIN_MAX
    || !LOCAL.test(local)
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
  ) {
    throw new InvitationRecipientUnavailableError();
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => label.length > 63 || !DOMAIN_LABEL.test(label))) {
    throw new InvitationRecipientUnavailableError();
  }
  return normalized;
}

export function maskInvitationEmail(normalizedEmail: string): string {
  const separator = normalizedEmail.indexOf("@");
  return `${normalizedEmail[0]}***@${normalizedEmail.slice(separator + 1)}`;
}

export function parseInvitationRecipientKeyring(raw: string | undefined): InvitationRecipientKeyring {
  try {
    const parsed = JSON.parse(raw ?? "") as { active?: unknown; keys?: unknown };
    if (typeof parsed.active !== "string" || !VERSION.test(parsed.active) || !parsed.keys || typeof parsed.keys !== "object" || Array.isArray(parsed.keys)) {
      throw new Error("invalid");
    }
    const entries = Object.entries(parsed.keys as Record<string, unknown>);
    if (!entries.length || entries.length > MAX_KEY_VERSIONS || !entries.some(([version]) => version === parsed.active)) throw new Error("invalid");
    const keys = new Map<string, Uint8Array>();
    for (const [version, encoded] of entries) {
      if (!VERSION.test(version) || typeof encoded !== "string" || !KEY_HEX.test(encoded) || keys.has(version)) throw new Error("invalid");
      keys.set(version, Uint8Array.from(encoded.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)));
    }
    return { activeVersion: parsed.active, keys };
  } catch {
    throw new InvitationRecipientUnavailableError();
  }
}

export function configuredInvitationRecipientKeyring() {
  return parseInvitationRecipientKeyring(process.env[INVITATION_RECIPIENT_KEYRING_ENV]);
}

async function keyedEmailHash(normalizedEmail: string, version: string, key: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = new TextEncoder().encode(`fable.invitation-recipient\0email\0${normalizedEmail}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, payload));
  const digest = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!KEY_HEX.test(digest) || !VERSION.test(version)) throw new InvitationRecipientUnavailableError();
  return digest;
}

export async function hashInvitationEmail(
  value: unknown,
  keyring: InvitationRecipientKeyring,
  version = keyring.activeVersion,
): Promise<HashedInvitationEmail> {
  const normalized = normalizeInvitationEmail(value);
  const key = keyring.keys.get(version);
  if (!key) throw new InvitationRecipientUnavailableError();
  return {
    attributeKind: "email",
    hashVersion: version,
    normalizedValueHash: await keyedEmailHash(normalized, version, key),
    displayHint: maskInvitationEmail(normalized),
  };
}

export async function hashInvitationEmailForRetainedVersions(value: unknown, keyring: InvitationRecipientKeyring) {
  const versions = [keyring.activeVersion, ...Array.from(keyring.keys.keys()).filter((version) => version !== keyring.activeVersion).sort()];
  return Promise.all(versions.map((version) => hashInvitationEmail(value, keyring, version)));
}
