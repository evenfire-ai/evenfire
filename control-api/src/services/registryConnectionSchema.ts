import type { DbClient } from '../db.js'

// ─── Self-hosted registry connection — schema (migration 0049_registry_connection) ──
// One row per control-api deployment (a control-api serves exactly one
// deployment), populated by the connect flow (register → approve → claim).
// Secrets (the deployment private key, the machine client secret) are stored
// AES-256-GCM encrypted via src/oauth/encryption.ts — never plaintext.
//
// Lives apart from a future registryConnectionDb.ts so db.ts can import it
// without a runtime import cycle (this module only has a type-only dependency
// on db) — mirrors the pluginWorkloadSdkSchema.ts convention.
export async function applyRegistryConnectionSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS registry_connection (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      singleton               BOOLEAN NOT NULL DEFAULT true,
      deployment_id           TEXT NOT NULL,
      key_id                  TEXT NOT NULL,
      public_key_pem          TEXT NOT NULL,
      private_key_encrypted   TEXT NOT NULL,
      client_id               TEXT NULL,
      client_secret_encrypted TEXT NULL,
      org_name                TEXT NULL,
      requested_org_name      TEXT NOT NULL,
      contact_email           TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','connected')),
      registry_url            TEXT NULL,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A control-api serves exactly one deployment: at most one row. The partial
    -- unique index on the constant 'singleton' column is the enforcement.
    CREATE UNIQUE INDEX IF NOT EXISTS registry_connection_singleton
      ON registry_connection (singleton);
  `)
}
