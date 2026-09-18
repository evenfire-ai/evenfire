import { randomBytes } from 'node:crypto'
import type { DbClient } from '../db.js'

const CONNECTION_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function generateGrokConnectionKey(): string {
  return `grok-${randomBytes(8).toString('hex')}`
}

export function assertGrokConnectionKey(value: string): string {
  const key = value.trim()
  if (!CONNECTION_KEY_RE.test(key) || key === 'unassigned' || key === 'deployment-default') {
    throw new Error(`invalid Grok connection key: ${key}`)
  }
  return key
}

export async function applyGrokSubscriptionConnectionSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS grok_subscription_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_key TEXT NOT NULL,
      display_name TEXT,
      created_by TEXT,
      default_model TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'disconnected', 'connecting', 'connected', 'reauth_required', 'revoked'
      )),
      refresh_token_encrypted TEXT,
      access_token_encrypted TEXT,
      access_token_expires_at TIMESTAMPTZ,
      credential_revision BIGINT NOT NULL DEFAULT 1
        CHECK (credential_revision >= 1),
      catalog_revision BIGINT NOT NULL DEFAULT 0
        CHECK (catalog_revision >= 0),
      account_fingerprint TEXT,
      catalog_status TEXT NOT NULL DEFAULT 'never_synced'
        CHECK (catalog_status IN ('never_synced', 'ready', 'auth-rejected', 'unavailable')),
      catalog_synced_at TIMESTAMPTZ,
      last_refresh_at TIMESTAMPTZ,
      last_auth_at TIMESTAMPTZ,
      refresh_lock_token TEXT,
      refresh_lock_expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT grok_subscription_connections_key_reserved_check
        CHECK (connection_key <> 'unassigned' AND connection_key <> 'deployment-default'),
      CONSTRAINT grok_subscription_connections_ciphertext_when_connected
        CHECK (
          status NOT IN ('connected', 'reauth_required')
          OR (
            refresh_token_encrypted IS NOT NULL
            AND account_fingerprint IS NOT NULL
          )
        )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS grok_subscription_connections_active_key
      ON grok_subscription_connections (connection_key)
      WHERE revoked_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS grok_subscription_connections_active_fingerprint
      ON grok_subscription_connections (account_fingerprint)
      WHERE revoked_at IS NULL AND account_fingerprint IS NOT NULL;

    REVOKE ALL PRIVILEGES ON TABLE grok_subscription_connections FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE grok_subscription_connections
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE grok_subscription_connections TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE grok_subscription_connections FROM control_api_runtime;
  `)
}

export async function applyGrokSubscriptionOAuthStateSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS grok_subscription_oauth_states (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      state TEXT NOT NULL,
      connection_key TEXT NOT NULL,
      flow TEXT NOT NULL CHECK (flow IN ('device')),
      intent TEXT NOT NULL CHECK (intent IN ('connect', 'reconnect', 'replace')),
      device_code_encrypted TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT grok_subscription_oauth_states_state_unique UNIQUE (state),
      CONSTRAINT grok_subscription_oauth_states_lifecycle CHECK (
        (status = 'pending' AND consumed_at IS NULL AND cancelled_at IS NULL)
        OR (status = 'consumed' AND consumed_at IS NOT NULL AND cancelled_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND consumed_at IS NULL)
        OR (status = 'expired' AND consumed_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS grok_subscription_oauth_states_pending_expiry_idx
      ON grok_subscription_oauth_states (expires_at)
      WHERE status = 'pending';

    REVOKE ALL PRIVILEGES ON TABLE grok_subscription_oauth_states FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE grok_subscription_oauth_states
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE grok_subscription_oauth_states TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE grok_subscription_oauth_states FROM control_api_runtime;
  `)
}

export async function applyGrokCatalogModelsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS grok_catalog_models (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id UUID NOT NULL REFERENCES grok_subscription_connections(id),
      model TEXT NOT NULL,
      display_name TEXT,
      context_window_tokens INTEGER,
      enabled BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL CHECK (source IN ('manual', 'discovery')),
      stale BOOLEAN NOT NULL DEFAULT false,
      discovered_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT grok_catalog_models_connection_model_unique UNIQUE (connection_id, model)
    );

    REVOKE ALL PRIVILEGES ON TABLE grok_catalog_models FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE grok_catalog_models
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE grok_catalog_models TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE grok_catalog_models FROM control_api_runtime;
  `)
}

export async function applyLlmProviderAttemptsGrokBrokerSchema(db: DbClient): Promise<void> {
  await db.query(`
    DO $$
    DECLARE
      constraint_name text;
    BEGIN
      SELECT c.conname INTO constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE t.relname = 'llm_provider_attempts'
         AND c.contype = 'c'
         AND a.attname = 'provider'
         AND pg_get_constraintdef(c.oid) LIKE '%codex-subscription%'
         AND pg_get_constraintdef(c.oid) NOT LIKE '%grok-subscription%'
       LIMIT 1;
      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE llm_provider_attempts DROP CONSTRAINT %I', constraint_name);
      END IF;
    END $$;

    ALTER TABLE llm_provider_attempts
      DROP CONSTRAINT IF EXISTS llm_provider_attempts_provider_check;

    ALTER TABLE llm_provider_attempts
      ADD CONSTRAINT llm_provider_attempts_provider_check
      CHECK (provider IN ('codex-subscription', 'grok-subscription'));

    ALTER TABLE llm_provider_attempts
      ADD CONSTRAINT llm_provider_attempts_grok_connection_id_required
      CHECK (provider <> 'grok-subscription' OR connection_id IS NOT NULL);

    DO $$
    DECLARE
      fk_name text;
    BEGIN
      SELECT c.conname INTO fk_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE t.relname = 'llm_provider_attempts'
         AND c.contype = 'f'
         AND a.attname = 'connection_id'
       LIMIT 1;
      IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE llm_provider_attempts DROP CONSTRAINT %I', fk_name);
      END IF;
    END $$;
  `)
}

/**
 * 0113 — revocation is terminal per Grok connection key.
 *
 * 0109 only enforced key uniqueness among live rows (`revoked_at IS NULL`), so
 * a revoked key could be revived by an older pending device flow (or a raw
 * insert) and existing key-based Host/recipe assignments would silently become
 * usable again. From 0113 a connection_key names exactly one row for its whole
 * lifetime; reconnecting after revoke requires a fresh key (the UI generates
 * `grok-<hex>` keys).
 *
 * Additive and idempotent, safe to run against DBs where 0109–0112 already ran:
 *   1. Archive superseded tombstones: when a key already has several rows (a
 *      live row plus tombstones, or several tombstones), every row except the
 *      live one — or, when no live row exists, the newest tombstone — gets its
 *      key rewritten to `<key>~revoked~<id>`. `~` is outside the key grammar, so
 *      archived keys can never collide with or be addressed as a real key.
 *      Rows are never deleted: catalog models and provider attempts keep
 *      pointing at their connection id.
 *   2. Cancel pending OAuth device states whose key is now a tombstone.
 *   3. Replace the live-only key index with a full unique index. The
 *      fingerprint index stays live-only (an account may reconnect under a new
 *      key).
 * Pods still running pre-0113 code keep working: a revive attempt now fails
 * closed with 23505 instead of creating a second row.
 */
export async function applyGrokSubscriptionTerminalConnectionKeySchema(
  db: DbClient
): Promise<void> {
  await db.query(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY connection_key
               ORDER BY revoked_at DESC NULLS FIRST, created_at DESC, id DESC
             ) AS key_rank
        FROM grok_subscription_connections
    )
    UPDATE grok_subscription_connections c
       SET connection_key = c.connection_key || '~revoked~' || c.id::text,
           updated_at = now()
      FROM ranked r
     WHERE r.id = c.id
       AND r.key_rank > 1
       AND c.revoked_at IS NOT NULL;

    UPDATE grok_subscription_oauth_states s
       SET status = 'cancelled',
           cancelled_at = now()
     WHERE s.status = 'pending'
       AND EXISTS (
         SELECT 1
           FROM grok_subscription_connections c
          WHERE c.connection_key = s.connection_key
            AND c.revoked_at IS NOT NULL
       );

    CREATE UNIQUE INDEX IF NOT EXISTS grok_subscription_connections_key_unique
      ON grok_subscription_connections (connection_key);

    DROP INDEX IF EXISTS grok_subscription_connections_active_key;
  `)
}
