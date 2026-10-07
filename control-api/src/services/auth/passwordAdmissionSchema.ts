import type { DbClient } from '../../db.js'
import { PASSWORD_ADMISSION_POLICY } from './passwordAdmissionState.js'

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

/** Forward capture retention, including deletion protection for older cleanup owners. */
export async function applyPasswordEvaluationRetentionSchema(
  db: Pick<DbClient, 'query'>
): Promise<void> {
  const lifetime = PASSWORD_ADMISSION_POLICY.evaluationMs
  await db.query(`
    ALTER TABLE password_identifier_state
      ADD COLUMN IF NOT EXISTS retained_until_ms BIGINT NOT NULL DEFAULT 0;
    UPDATE password_identifier_state
       SET retained_until_ms = greatest(retained_until_ms,
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${lifetime});
    CREATE OR REPLACE FUNCTION password_evaluation_retention() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    DECLARE deadline bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${lifetime};
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.retained_until_ms > deadline - ${lifetime} THEN RETURN NULL; END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'INSERT' THEN
        NEW.retained_until_ms := greatest(NEW.retained_until_ms, deadline);
      ELSIF NEW.retained_until_ms = OLD.retained_until_ms
        AND NEW.revision = OLD.revision
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND cardinality(NEW.failures) <= cardinality(OLD.failures)
        AND NEW.locked_until_ms <= OLD.locked_until_ms THEN
        -- Older capture producers write settled history without retention metadata.
        -- Retain those captures too; denials do not write and cannot extend retention.
        NEW.retained_until_ms := greatest(OLD.retained_until_ms, deadline);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS password_evaluation_retention ON password_identifier_state;
    CREATE TRIGGER password_evaluation_retention BEFORE INSERT OR UPDATE OR DELETE
      ON password_identifier_state FOR EACH ROW EXECUTE FUNCTION password_evaluation_retention();
  `)
}
