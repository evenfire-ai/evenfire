import type { DbClient } from '../../db.js'

/** New forward migration; database triggers cover all credential/lifecycle producers. */
export async function applyPasswordAdmissionSchema(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_auth_generation BIGINT NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS password_identifier_state (
      identifier_key TEXT PRIMARY KEY CHECK (identifier_key ~ '^[0-9a-f]{64}$'),
      instance UUID NOT NULL DEFAULT gen_random_uuid(),
      revision BIGINT NOT NULL DEFAULT 1,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      attempts BIGINT[] NOT NULL DEFAULT '{}',
      failures BIGINT[] NOT NULL DEFAULT '{}',
      locked_until_ms BIGINT NOT NULL DEFAULT 0,
      CHECK (cardinality(attempts) <= 5), CHECK (cardinality(failures) <= 5)
    );
    CREATE INDEX IF NOT EXISTS password_identifier_user_idx ON password_identifier_state(user_id);
    CREATE TABLE IF NOT EXISTS password_verification_pace (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      next_permit TIMESTAMPTZ NOT NULL
    );
    CREATE OR REPLACE FUNCTION password_credential_generation_fence() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.password_auth_generation := 1;
        UPDATE public.password_identifier_state
           SET failures = '{}', locked_until_ms = 0, revision = revision + 1
         WHERE identifier_key = encode(sha256(convert_to(NEW.email, 'UTF8')), 'hex');
        RETURN NEW;
      END IF;
      IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
         OR NEW.email IS DISTINCT FROM OLD.email
         OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
         OR NEW.lifecycle_version IS DISTINCT FROM OLD.lifecycle_version THEN
        NEW.password_auth_generation := OLD.password_auth_generation + 1;
        UPDATE public.password_identifier_state
           SET failures = '{}', locked_until_ms = 0, revision = revision + 1
         WHERE user_id = OLD.id
            OR identifier_key IN (
              encode(sha256(convert_to(OLD.email, 'UTF8')), 'hex'),
              encode(sha256(convert_to(NEW.email, 'UTF8')), 'hex'));
      ELSE
        NEW.password_auth_generation := OLD.password_auth_generation;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS password_credential_generation_fence ON users;
    CREATE TRIGGER password_credential_generation_fence BEFORE INSERT OR UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION password_credential_generation_fence();
    GRANT SELECT, INSERT, UPDATE, DELETE ON password_identifier_state, password_verification_pace
      TO control_api_runtime;
  `)
}
