/**
 * D1 access layer. EVERY query uses bound parameters. No string interpolation.
 * All functions are async and return plain objects.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { D1SubscriberRow, SubscriberStatus } from "./types.js";

export interface WaitlistDB {
  findByEmailHash(hash: string): Promise<D1SubscriberRow | null>;
  insertPending(params: {
    id: string;
    emailCipher: string;
    emailHash: string;
    consentVersion: string;
    consentTextHash: string;
    consentMarketing: boolean;
    platform: string;
    connectorsJson: string | null;
    referral: string | null;
    locale: string | null;
    confirmTokenHash: string;
    confirmExpires: string;
    now: string;
  }): Promise<void>;
  markConfirmed(id: string, now: string): Promise<void>;
  setUnsubscribed(id: string, now: string): Promise<void>;
  setDeleted(id: string, now: string): Promise<void>;
  updateConfirmToken(id: string, newHash: string, newExpires: string, now: string): Promise<void>;
  getByConfirmTokenHash(hash: string, now: string): Promise<D1SubscriberRow | null>;
  exportForId(id: string, emailKey: string): Promise<any>; // shape per schema, decrypted
  hardDelete(id: string): Promise<void>;
}

export function createWaitlistDB(d1: D1Database, emailEncKey: string): WaitlistDB {
  return {
    async findByEmailHash(hash: string) {
      const res = await d1
        .prepare("SELECT * FROM subscribers WHERE email_hash = ?1 LIMIT 1")
        .bind(hash)
        .first<D1SubscriberRow>();
      return res ?? null;
    },

    async insertPending(p) {
      await d1
        .prepare(
          `INSERT INTO subscribers (
            id, email_ciphertext, email_hash, status, consent_version, consent_text_hash,
            consent_marketing, platform_interest, connector_interest_json, referral_code,
            confirm_token_hash, confirm_expires_at, locale, source, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'web_waitlist', ?13, ?13)`
        )
        .bind(
          p.id,
          p.emailCipher,
          p.emailHash,
          p.consentVersion,
          p.consentTextHash,
          p.consentMarketing ? 1 : 0,
          p.platform,
          p.connectorsJson,
          p.referral,
          p.confirmTokenHash,
          p.confirmExpires,
          p.locale,
          p.now
        )
        .run();
    },

    async markConfirmed(id: string, now: string) {
      await d1
        .prepare(
          "UPDATE subscribers SET status='confirmed', confirmed_at=?1, updated_at=?1 WHERE id=?2 AND status='pending'"
        )
        .bind(now, id)
        .run();
    },

    async setUnsubscribed(id: string, now: string) {
      await d1
        .prepare("UPDATE subscribers SET status='unsubscribed', updated_at=?1 WHERE id=?2")
        .bind(now, id)
        .run();
    },

    async setDeleted(id: string, now: string) {
      await d1
        .prepare("UPDATE subscribers SET status='deleted', deleted_at=?1, updated_at=?1 WHERE id=?2")
        .bind(now, id)
        .run();
    },

    async updateConfirmToken(id, newHash, newExpires, now) {
      await d1
        .prepare(
          "UPDATE subscribers SET confirm_token_hash=?1, confirm_expires_at=?2, updated_at=?3 WHERE id=?4"
        )
        .bind(newHash, newExpires, now, id)
        .run();
    },

    async getByConfirmTokenHash(hash: string, now: string) {
      const row = await d1
        .prepare("SELECT * FROM subscribers WHERE confirm_token_hash = ?1 LIMIT 1")
        .bind(hash)
        .first<D1SubscriberRow>();
      if (!row) return null;
      // caller checks expiry
      return row;
    },

    async exportForId(id: string, emailKey: string) {
      const row = await d1
        .prepare("SELECT * FROM subscribers WHERE id = ?1 LIMIT 1")
        .bind(id)
        .first<D1SubscriberRow>();
      if (!row) return null;
      // decrypt for export only
      const { decryptEmail } = await import("./crypto.js");
      const email = await decryptEmail(row.email_ciphertext, emailKey);
      return {
        id: row.id,
        email,
        status: row.status,
        consent_version: row.consent_version,
        consent_marketing: !!row.consent_marketing,
        platform_interest: row.platform_interest,
        connector_interest: row.connector_interest_json ? JSON.parse(row.connector_interest_json) : undefined,
        referral_code: row.referral_code ?? undefined,
        created_at: row.created_at,
        confirmed_at: row.confirmed_at ?? undefined,
        updated_at: row.updated_at
      };
    },

    async hardDelete(id: string) {
      await d1.prepare("DELETE FROM subscribers WHERE id = ?1").bind(id).run();
      await d1.prepare("DELETE FROM consent_audits WHERE subscriber_id = ?1").bind(id).run();
    }
  };
}
