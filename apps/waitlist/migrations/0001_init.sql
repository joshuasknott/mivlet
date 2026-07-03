-- Initial waitlist schema (D1 / SQLite)
-- Matches waitlist-api.schema.json D1SubscriberRow + consent audit separation
-- All queries in code MUST use parameters; never interpolate.

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,                     -- uuid
  email_ciphertext TEXT NOT NULL,          -- encrypted at rest (placeholder; future key rotation)
  email_hash TEXT NOT NULL UNIQUE,         -- sha256(hmac(email, pepper))
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','unsubscribed','deleted')),
  consent_version TEXT NOT NULL,           -- e.g. 2026-07-03-waitlist-v0.1
  consent_text_hash TEXT NOT NULL,         -- server-computed sha256 of exact text shown
  consent_marketing INTEGER NOT NULL CHECK(consent_marketing IN (0,1)),
  platform_interest TEXT NOT NULL DEFAULT 'windows' CHECK(platform_interest IN ('windows','macos','linux','unspecified')),
  connector_interest_json TEXT,            -- JSON array or null
  referral_code TEXT,
  confirm_token_hash TEXT,
  confirm_expires_at TEXT,                 -- ISO
  locale TEXT,
  source TEXT NOT NULL DEFAULT 'web_waitlist',
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email_hash ON subscribers(email_hash);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_subscribers_confirm_token ON subscribers(confirm_token_hash);

-- Simple consent audit log (append-only, for proof of what was shown)
CREATE TABLE IF NOT EXISTS consent_audits (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_text_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
);

CREATE INDEX IF NOT EXISTS idx_audits_sub ON consent_audits(subscriber_id);
