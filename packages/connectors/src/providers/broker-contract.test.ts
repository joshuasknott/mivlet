import { describe, expect, it } from "vitest";

import {
  BROKER_PKCE_CHALLENGE_METHOD,
  BROKER_PKCE_S256_EXAMPLE,
  BrokerContractError,
  assertBrokerPkceChallenge,
  assertBrokerPkceVerifier
} from "./broker-contract";

describe("broker PKCE contract", () => {
  it("accepts the RFC 7636 Appendix B S256 example", () => {
    expect(() => assertBrokerPkceChallenge(
      BROKER_PKCE_S256_EXAMPLE.challenge,
      BROKER_PKCE_CHALLENGE_METHOD
    )).not.toThrow();
    expect(() => assertBrokerPkceVerifier(BROKER_PKCE_S256_EXAMPLE.verifier)).not.toThrow();
  });

  it("rejects plain, missing, and malformed challenges", () => {
    expect(() => assertBrokerPkceChallenge(BROKER_PKCE_S256_EXAMPLE.challenge, "plain"))
      .toThrow(BrokerContractError);
    expect(() => assertBrokerPkceChallenge(BROKER_PKCE_S256_EXAMPLE.challenge, undefined))
      .toThrow(/must be S256/);
    expect(() => assertBrokerPkceChallenge("ch", BROKER_PKCE_CHALLENGE_METHOD))
      .toThrow(/code_challenge is invalid/);
    expect(() => assertBrokerPkceChallenge(`${BROKER_PKCE_S256_EXAMPLE.challenge}=`, BROKER_PKCE_CHALLENGE_METHOD))
      .toThrow(/code_challenge is invalid/);
    expect(() => assertBrokerPkceChallenge("a".repeat(43), BROKER_PKCE_CHALLENGE_METHOD))
      .not.toThrow();
  });

  it("rejects short, overlong, and reserved-character verifiers", () => {
    expect(() => assertBrokerPkceVerifier("short")).toThrow(/code_verifier is invalid/);
    expect(() => assertBrokerPkceVerifier("a".repeat(42))).toThrow(/code_verifier is invalid/);
    expect(() => assertBrokerPkceVerifier("a".repeat(129))).toThrow(/code_verifier is invalid/);
    expect(() => assertBrokerPkceVerifier(`${"a".repeat(42)}+`)).toThrow(/code_verifier is invalid/);
    expect(() => assertBrokerPkceVerifier("a".repeat(43))).not.toThrow();
    expect(() => assertBrokerPkceVerifier("a".repeat(128))).not.toThrow();
  });
});
