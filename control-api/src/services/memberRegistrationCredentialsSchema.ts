import type { DbClient } from '../db.js'

// ─── Hosted member-registration credentials — schema (migration 0068) ──
// One row per (bound_domain, mint). The hub binds each credential to exactly one
// destination hostname; hosted mode mints one per configured UI host (spec §8.2).
// `secret_encrypted` is AES-256-GCM via src/oauth/encryption.ts — never plaintext.
// Rotation is ops-level: UPDATE ... SET revoked_at = now(), secret_encrypted = ''
// frees the partial-unique slot; the next send/boot re-mints.
//
// Type-only dependency on db.js so db.ts can import it without a runtime cycle —
// mirrors registryConnectionSchema.ts.
export async function applyMemberRegistrationCredentialsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS member_registration_credentials (
      id               BIGSERIAL PRIMARY KEY,
      bound_domain     TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      kid              TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at       TIMESTAMPTZ
    );

    -- At most one ACTIVE credential per bound domain; revoked rows stay as audit
    -- trail (with secret_encrypted blanked). The re-mint path relies on the
    -- WHERE clause: a revoked row must not block a fresh INSERT.
    CREATE UNIQUE INDEX IF NOT EXISTS member_registration_credentials_active_domain_idx
      ON member_registration_credentials (bound_domain)
      WHERE revoked_at IS NULL;
  `)
}
