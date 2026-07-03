/**
 * Internal types matching waitlist-api.schema.json
 */

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed" | "deleted";

export interface D1SubscriberRow {
  id: string;
  email_ciphertext: string;
  email_hash: string;
  status: SubscriberStatus;
  consent_version: string;
  consent_text_hash: string;
  consent_marketing: 0 | 1;
  platform_interest: string;
  connector_interest_json: string | null;
  referral_code: string | null;
  confirm_token_hash: string | null;
  confirm_expires_at: string | null;
  locale: string | null;
  source: string;
  created_at: string;
  confirmed_at: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface SignupInput {
  email: string;
  consent_marketing: true;
  consent_version: string;
  platform_interest?: string;
  connector_interest?: string[];
  referral_code?: string;
  turnstile_token: string;
  website?: string; // honeypot
  // locale from header in handler
}

export interface SignupResult {
  id: string;
  status: "pending";
}

export interface ErrorBody {
  error: { code: string; message: string };
}

export const ERROR_CODES = [
  "invalid-request",
  "turnstile-failed",
  "rate-limited",
  "consent-invalid",
  "token-invalid",
  "token-expired",
  "not-found",
  "server-error"
] as const;
