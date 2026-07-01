/**
 * Remote pairing — pure validation logic, no crypto secrets in JS.
 *
 * Pairing establishes pairwise local trust between a mobile device and the
 * desktop. The flow is:
 *   1. Desktop issues a `RemotePairingChallenge` (nonce + short confirm code).
 *   2. Mobile scans the QR (which carries the ephemeral PSK + LAN endpoint) and
 *      types the short confirm code shown on the desktop.
 *   3. The confirm code proves physical presence — a remote attacker who only
 *      captured the QR (e.g. via a screenshot) cannot pair without it.
 *   4. The future Rust transport verifies PSK-derived proof internally.
 *
 * This module owns only the confirm-code window/match validation — the part
 * that is pure and free of secret material. PSK proof verification is Rust-side.
 *
 * SECRET INVARIANT: this module holds no PSK, no proof material, and no
 * long-lived device key.
 */

import type { RemoteErrorCode } from "@fable/protocol";
import type { Now } from "./session";

/** How long a pairing challenge remains valid after issuance. */
export const PAIRING_CHALLENGE_TTL_MS = 1000 * 60 * 5; // 5 minutes

/** Length of the short numeric confirm code (physical-presence proof). */
export const CONFIRM_CODE_LENGTH = 6;

/** A validated or rejected confirm code. */
export type ConfirmCodeResult =
  | { ok: true }
  | { ok: false; code: RemoteErrorCode; message: string };

/**
 * Validate a confirm code against an issued challenge within its time window.
 * Pure: takes expected vs. provided and the timestamps as data. The PSK proof
 * itself is verified separately in Rust; this only checks the human factor.
 */
export function verifyConfirmCode(input: {
  expected: string;
  provided: string;
  issuedAt: string;
  expiresAt: string;
  now: Now;
}): ConfirmCodeResult {
  const { expected, provided, issuedAt, expiresAt, now } = input;
  const at = new Date(now()).getTime();
  const issued = new Date(issuedAt).getTime();
  const expires = new Date(expiresAt).getTime();

  if (Number.isNaN(issued) || Number.isNaN(expires)) {
    return {
      ok: false,
      code: "invalid-command",
      message: "Pairing challenge has invalid timestamps."
    };
  }

  if (at < issued) {
    // Challenge not yet valid (clock skew). Fail closed.
    return {
      ok: false,
      code: "unauthorized",
      message: "Pairing challenge is not yet valid."
    };
  }

  if (at >= expires) {
    return {
      ok: false,
      code: "unauthorized",
      message: "Pairing challenge has expired."
    };
  }

  // Constant-time-ish equality is not needed here: the confirm code is a short,
  // public, human-typed value already shown on the desktop screen. A plain
  // mismatch is the only failure mode that matters.
  if (expected !== provided) {
    return {
      ok: false,
      code: "unauthorized",
      message: "Confirmation code did not match."
    };
  }

  return { ok: true };
}

/**
 * Deterministic fixture helper that produces a valid-format confirm code from a
 * seed. Mirrors how connectors expose fixture builders (e.g. local-file
 * candidates) so tests are deterministic without depending on real randomness.
 * Not for production use.
 */
export function generateConfirmCodeFixture(seed: number): string {
  // 6-digit numeric code derived deterministically from the seed.
  const code = Math.abs(Math.floor(seed)) % 1_000_000;
  return code.toString().padStart(CONFIRM_CODE_LENGTH, "0");
}

/**
 * Build a challenge expiry timestamp from an issue time. Pure helper so callers
 * don't repeat the TTL arithmetic.
 */
export function challengeExpiry(issuedAt: string): string {
  return new Date(new Date(issuedAt).getTime() + PAIRING_CHALLENGE_TTL_MS).toISOString();
}
