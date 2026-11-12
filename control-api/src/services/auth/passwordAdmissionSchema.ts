import type { DbClient } from '../../db.js'
import { PASSWORD_ADMISSION_POLICY } from './passwordAdmissionState.js'

const PASSWORD_ADMISSION_ROLLOUT_TABLE = 'password_admission_rollout_state'

const PASSWORD_ADMISSION_ROLLOUT_GUARDS_SQL = `
  CREATE OR REPLACE FUNCTION password_admission_rollout_state_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DECLARE rollout_phase text;
  BEGIN
    -- This compatibility fence targets application sessions; migration and
    -- security review roles remain able to maintain admission state directly.
    IF session_user <> 'control_api_runtime'
       AND current_setting('role', true) IS DISTINCT FROM 'control_api_runtime' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    SELECT phase INTO rollout_phase
      FROM public.password_admission_rollout_state WHERE singleton = TRUE;
    IF rollout_phase IS NULL THEN
      RAISE EXCEPTION 'password admission rollout state unavailable' USING ERRCODE = '55000';
    END IF;
    IF rollout_phase = 'legacy' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF current_setting('app.password_admission_rollout_migration', true) = 'v2' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    -- A governed physical user retirement performs this exact FK action after
    -- it records its durable pending operation. Allow only that nested detach;
    -- direct or unrelated runtime edits remain fenced, and retained history is
    -- otherwise byte-for-byte unchanged.
    IF rollout_phase = 'v2'
       AND TG_OP = 'UPDATE'
       AND pg_trigger_depth() > 1
       AND OLD.user_id IS NOT NULL
       AND NEW.user_id IS NULL
       AND (to_jsonb(NEW) - 'user_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'user_id')
       AND NOT EXISTS (
         SELECT 1 FROM public.users WHERE id = OLD.user_id
       )
       AND EXISTS (
         SELECT 1
           FROM public.desktop_user_retirement_operations AS retirement
          WHERE retirement.operation = 'retire_desktop_user'
            AND retirement.target_user_id = OLD.user_id
            AND retirement.status = 'pending'
            AND retirement.outcome IS NULL
            AND retirement.completed_at IS NULL
            AND retirement.xmin = pg_current_xact_id()::xid
       ) THEN
      RETURN NEW;
    END IF;
    IF rollout_phase = 'v2'
       AND current_setting('app.password_admission_protocol', true) = 'v2' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'password admission rollout is fenced' USING ERRCODE = '55000';
  END $$;

  CREATE OR REPLACE FUNCTION password_admission_rollout_owner_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DECLARE rollout_phase text;
  BEGIN
    IF session_user <> 'control_api_runtime'
       AND current_setting('role', true) IS DISTINCT FROM 'control_api_runtime' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    SELECT phase INTO rollout_phase
      FROM public.password_admission_rollout_state WHERE singleton = TRUE;
    IF rollout_phase IS NULL THEN
      RAISE EXCEPTION 'password admission rollout state unavailable' USING ERRCODE = '55000';
    END IF;
    IF rollout_phase = 'legacy' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    -- An old verifier may release its existing owner, but cannot acquire/reacquire during drain.
    IF rollout_phase = 'draining' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF current_setting('app.password_admission_rollout_migration', true) = 'v2' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF rollout_phase = 'v2'
       AND current_setting('app.password_admission_protocol', true) = 'v2' THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'password admission rollout is fenced' USING ERRCODE = '55000';
  END $$;

  CREATE OR REPLACE FUNCTION password_admission_rollout_is_ready() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.password_admission_rollout_state
       WHERE singleton = TRUE AND phase = 'v2'
    )
  $$;
  REVOKE ALL ON FUNCTION password_admission_rollout_state_guard() FROM PUBLIC, control_api_runtime;
  REVOKE ALL ON FUNCTION password_admission_rollout_owner_guard() FROM PUBLIC, control_api_runtime;
  REVOKE ALL ON FUNCTION password_admission_rollout_is_ready() FROM PUBLIC, control_api_runtime;
  GRANT EXECUTE ON FUNCTION password_admission_rollout_is_ready() TO control_api_runtime;

  DROP TRIGGER IF EXISTS password_admission_rollout_state_guard
    ON password_identifier_state;
  CREATE TRIGGER password_admission_rollout_state_guard
    BEFORE INSERT OR UPDATE OR DELETE ON password_identifier_state
    FOR EACH ROW EXECUTE FUNCTION password_admission_rollout_state_guard();
  DROP TRIGGER IF EXISTS password_admission_rollout_owner_guard
    ON password_verification_work;
  CREATE TRIGGER password_admission_rollout_owner_guard
    BEFORE INSERT OR UPDATE OR DELETE ON password_verification_work
    FOR EACH ROW EXECUTE FUNCTION password_admission_rollout_owner_guard();
`

async function installPasswordAdmissionRolloutGuards(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(PASSWORD_ADMISSION_ROLLOUT_GUARDS_SQL)
}

/**
 * Commit this fence before applying the outcome-accounting schema. The legacy
 * verifier does not set the protocol GUC, so it can no longer start a new
 * durable work-owner operation or mutate identifier admission state once this
 * transaction commits. Existing work-owner DELETEs remain possible so the
 * migration runner can drain work that already entered bcrypt.
 */
export async function preparePasswordAdmissionRolloutFence(
  db: Pick<DbClient, 'query'>
): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${PASSWORD_ADMISSION_ROLLOUT_TABLE} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      phase TEXT NOT NULL DEFAULT 'legacy'
        CHECK (phase IN ('legacy', 'draining', 'v2')),
      fenced_at_ms BIGINT
    );
    INSERT INTO ${PASSWORD_ADMISSION_ROLLOUT_TABLE}(singleton, phase)
      VALUES (TRUE, 'legacy') ON CONFLICT (singleton) DO NOTHING;
    REVOKE ALL ON ${PASSWORD_ADMISSION_ROLLOUT_TABLE} FROM PUBLIC, control_api_runtime;

    UPDATE ${PASSWORD_ADMISSION_ROLLOUT_TABLE}
       SET phase = 'draining'
     WHERE singleton = TRUE AND phase IN ('legacy', 'draining');
  `)

  const phase = await db.query(
    `SELECT phase FROM ${PASSWORD_ADMISSION_ROLLOUT_TABLE} WHERE singleton = TRUE`
  )
  if ((phase.rows[0] as { phase?: string } | undefined)?.phase !== 'draining') {
    throw new Error('password admission rollout state is not drainable')
  }
  await installPasswordAdmissionRolloutGuards(db)
  // Trigger DDL waits for legacy transactions already holding the admission rows. Record the
  // hold anchor only after that barrier and the legacy-write guards are installed, so the hold
  // cannot expire before a pre-fence completion has either committed or become fenced.
  await db.query(`
    UPDATE ${PASSWORD_ADMISSION_ROLLOUT_TABLE}
       SET fenced_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
     WHERE singleton = TRUE AND phase = 'draining'
  `)
}

/** Read-only drain check; never reclaims or interprets a stale owner by age. */
export async function passwordVerificationOwnerCount(db: Pick<DbClient, 'query'>): Promise<number> {
  const result = await db.query(
    'SELECT count(*)::integer AS active_count FROM password_verification_work'
  )
  return Number((result.rows[0] as { active_count: number | string }).active_count)
}

/** Assert that a committed migration left the rollout fence in v2-ready state. */
export async function assertPasswordAdmissionRolloutReady(
  db: Pick<DbClient, 'query'>
): Promise<void> {
  const result = await db.query('SELECT password_admission_rollout_is_ready() AS ready')
  if ((result.rows[0] as { ready?: boolean } | undefined)?.ready !== true) {
    throw new Error('password admission rollout is not ready')
  }
}

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

/**
 * Forward-only outcome accounting and compatibility fence for the first state-machine adopter.
 * Old verifier binaries do not set the protocol GUC and therefore fail closed after this commits.
 */
export async function applyPasswordSuccessAdmissionSchema(
  db: Pick<DbClient, 'query'>
): Promise<void> {
  const windowMs = PASSWORD_ADMISSION_POLICY.windowMs
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${PASSWORD_ADMISSION_ROLLOUT_TABLE} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      phase TEXT NOT NULL DEFAULT 'legacy'
        CHECK (phase IN ('legacy', 'draining', 'v2')),
      fenced_at_ms BIGINT
    );
    INSERT INTO ${PASSWORD_ADMISSION_ROLLOUT_TABLE}(singleton, phase)
      VALUES (TRUE, 'legacy') ON CONFLICT (singleton) DO NOTHING;
    REVOKE ALL ON ${PASSWORD_ADMISSION_ROLLOUT_TABLE} FROM PUBLIC, control_api_runtime;

    ALTER TABLE password_identifier_state
      ADD COLUMN IF NOT EXISTS successes BIGINT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS uncertain BIGINT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS legacy_hold_until_ms BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS provisional_operation UUID,
      ADD COLUMN IF NOT EXISTS provisional_phase TEXT,
      ADD COLUMN IF NOT EXISTS provisional_scope TEXT,
      ADD COLUMN IF NOT EXISTS provisional_epoch BIGINT,
      ADD COLUMN IF NOT EXISTS provisional_expires_at_ms BIGINT,
      ADD COLUMN IF NOT EXISTS provisional_quota_masked BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS provisional_started_at_ms BIGINT,
      ADD COLUMN IF NOT EXISTS provisional_owner_instance UUID,
      ADD COLUMN IF NOT EXISTS provisional_owner_host TEXT,
      ADD COLUMN IF NOT EXISTS provisional_owner_pid INTEGER,
      ADD COLUMN IF NOT EXISTS provisional_user_id UUID,
      ADD COLUMN IF NOT EXISTS provisional_generation BIGINT,
      ADD COLUMN IF NOT EXISTS terminal_operation UUID,
      ADD COLUMN IF NOT EXISTS terminal_disposition TEXT,
      ADD COLUMN IF NOT EXISTS terminal_at_ms BIGINT,
      ADD COLUMN IF NOT EXISTS terminal_epoch BIGINT;

    -- Old attempts are not classifiable as successes or failures. The committed rollout fence
    -- timestamp bounds every legacy capture and drained verification, even when the completion
    -- timestamp is not represented in the v1 attempt array.
    UPDATE password_identifier_state AS state
       SET legacy_hold_until_ms = greatest(
         state.legacy_hold_until_ms,
         COALESCE((SELECT fenced_at_ms + ${windowMs}
                     FROM ${PASSWORD_ADMISSION_ROLLOUT_TABLE}
                    WHERE singleton = TRUE AND phase = 'draining'), 0),
         COALESCE((
         SELECT max(attempt_ms) + ${windowMs}
           FROM unnest(state.attempts) AS legacy(attempt_ms)
          WHERE attempt_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${windowMs}
         ), 0)
       );

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.password_identifier_state'::regclass
                        AND conname = 'password_identifier_successes_max') THEN
        ALTER TABLE password_identifier_state ADD CONSTRAINT password_identifier_successes_max
          CHECK (cardinality(successes) <= 40);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.password_identifier_state'::regclass
                        AND conname = 'password_identifier_uncertain_max') THEN
        ALTER TABLE password_identifier_state ADD CONSTRAINT password_identifier_uncertain_max
          CHECK (cardinality(uncertain) <= 5);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.password_identifier_state'::regclass
                        AND conname = 'password_identifier_terminal_shape') THEN
        ALTER TABLE password_identifier_state ADD CONSTRAINT password_identifier_terminal_shape
          CHECK (
            (terminal_operation IS NULL AND terminal_disposition IS NULL
              AND terminal_at_ms IS NULL AND terminal_epoch IS NULL)
            OR
            (terminal_operation IS NOT NULL AND terminal_disposition IS NOT NULL
              AND terminal_disposition IN
              ('success', 'failure', 'stale', 'cancelled', 'uncertain')
              AND terminal_at_ms IS NOT NULL AND terminal_epoch IS NOT NULL)
          );
      END IF;
    END $$;

    -- Replace this same-name constraint when replaying the unapplied 0130 body. PostgreSQL CHECK
    -- accepts UNKNOWN, so the active-operation branch must state phase/scope non-null explicitly.
    ALTER TABLE password_identifier_state
      DROP CONSTRAINT IF EXISTS password_identifier_provisional_shape;
    ALTER TABLE password_identifier_state
      ADD CONSTRAINT password_identifier_provisional_shape
      CHECK (
        (provisional_operation IS NULL AND provisional_phase IS NULL
          AND provisional_scope IS NULL AND provisional_epoch IS NULL
          AND provisional_expires_at_ms IS NULL AND provisional_started_at_ms IS NULL
          AND provisional_owner_instance IS NULL AND provisional_owner_host IS NULL
          AND provisional_owner_pid IS NULL AND provisional_user_id IS NULL
          AND provisional_generation IS NULL AND provisional_quota_masked = FALSE)
        OR
        (provisional_operation IS NOT NULL AND provisional_phase IS NOT NULL
          AND provisional_phase IN ('reserved', 'running')
          AND provisional_scope IS NOT NULL
          AND provisional_scope IN ('public_login', 'authenticated_reverification')
          AND provisional_epoch IS NOT NULL AND provisional_expires_at_ms IS NOT NULL
          AND ((provisional_phase = 'reserved' AND provisional_started_at_ms IS NULL
                AND provisional_owner_instance IS NULL AND provisional_owner_host IS NULL
                AND provisional_owner_pid IS NULL AND provisional_user_id IS NULL
                AND provisional_generation IS NULL)
            OR (provisional_phase = 'running' AND provisional_started_at_ms IS NOT NULL
                AND provisional_owner_instance IS NOT NULL AND provisional_owner_host IS NOT NULL
                AND provisional_owner_pid IS NOT NULL AND provisional_owner_pid > 0))
        )
      );

    CREATE INDEX IF NOT EXISTS password_identifier_admission_retention_idx
      ON password_identifier_state(retained_until_ms);
    CREATE INDEX IF NOT EXISTS password_identifier_running_idx
      ON password_identifier_state(provisional_owner_instance, provisional_started_at_ms)
      WHERE provisional_phase = 'running';

    CREATE OR REPLACE FUNCTION password_admission_protocol_fence() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    BEGIN
      IF current_user = 'control_api_runtime'
         AND current_setting('app.password_admission_protocol', true) IS DISTINCT FROM 'v2'
         AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'password admission protocol mismatch'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS password_admission_protocol_fence ON password_identifier_state;
    CREATE TRIGGER password_admission_protocol_fence BEFORE INSERT OR UPDATE OR DELETE
      ON password_identifier_state FOR EACH ROW EXECUTE FUNCTION password_admission_protocol_fence();

    CREATE OR REPLACE FUNCTION password_credential_generation_fence() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    DECLARE old_key text; new_key text;
    BEGIN
      -- Trusted credential/lifecycle producers use the same protocol fence as the verifier.
      PERFORM set_config('app.password_admission_protocol', 'v2', true);
      IF TG_OP = 'INSERT' THEN
        NEW.password_auth_generation := 1;
        new_key := encode(sha256(convert_to(lower(btrim(NEW.email)), 'UTF8')), 'hex');
        UPDATE public.password_identifier_state
           SET failures = '{}', uncertain = '{}', locked_until_ms = 0,
               revision = revision + 1,
               terminal_operation = CASE WHEN provisional_phase = 'reserved'
                                         THEN provisional_operation ELSE terminal_operation END,
               terminal_disposition = CASE WHEN provisional_phase = 'reserved'
                                           THEN 'stale' ELSE terminal_disposition END,
               terminal_at_ms = CASE WHEN provisional_phase = 'reserved'
                                     THEN floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                                     ELSE terminal_at_ms END,
               terminal_epoch = CASE WHEN provisional_phase = 'reserved'
                                     THEN revision + 1 ELSE terminal_epoch END,
               provisional_operation = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                             ELSE provisional_operation END,
               provisional_phase = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                        ELSE provisional_phase END,
               provisional_scope = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                        ELSE provisional_scope END,
               provisional_epoch = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                        ELSE provisional_epoch END,
               provisional_expires_at_ms = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                                 ELSE provisional_expires_at_ms END,
               provisional_quota_masked = CASE WHEN provisional_phase = 'reserved' THEN FALSE
                                                ELSE provisional_quota_masked END,
               provisional_started_at_ms = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                                 ELSE provisional_started_at_ms END,
               provisional_owner_instance = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                                   ELSE provisional_owner_instance END,
               provisional_owner_host = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                             ELSE provisional_owner_host END,
               provisional_owner_pid = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                            ELSE provisional_owner_pid END,
               provisional_user_id = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                          ELSE provisional_user_id END,
               provisional_generation = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                             ELSE provisional_generation END
         WHERE identifier_key = new_key;
        RETURN NEW;
      END IF;
      IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
         OR NEW.email IS DISTINCT FROM OLD.email
         OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
         OR NEW.lifecycle_version IS DISTINCT FROM OLD.lifecycle_version THEN
        NEW.password_auth_generation := OLD.password_auth_generation + 1;
        old_key := encode(sha256(convert_to(lower(btrim(OLD.email)), 'UTF8')), 'hex');
        new_key := encode(sha256(convert_to(lower(btrim(NEW.email)), 'UTF8')), 'hex');
        UPDATE public.password_identifier_state
           SET failures = '{}', uncertain = '{}', locked_until_ms = 0,
               revision = revision + 1,
               user_id = CASE WHEN identifier_key = new_key THEN NEW.id ELSE user_id END,
               terminal_operation = CASE WHEN provisional_phase = 'reserved'
                                         THEN provisional_operation ELSE terminal_operation END,
               terminal_disposition = CASE WHEN provisional_phase = 'reserved'
                                           THEN 'stale' ELSE terminal_disposition END,
               terminal_at_ms = CASE WHEN provisional_phase = 'reserved'
                                     THEN floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                                     ELSE terminal_at_ms END,
               terminal_epoch = CASE WHEN provisional_phase = 'reserved'
                                     THEN revision + 1 ELSE terminal_epoch END,
               provisional_operation = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                             ELSE provisional_operation END,
               provisional_phase = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                        ELSE provisional_phase END,
               provisional_scope = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                        ELSE provisional_scope END,
               provisional_epoch = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                        ELSE provisional_epoch END,
               provisional_expires_at_ms = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                                 ELSE provisional_expires_at_ms END,
               provisional_quota_masked = CASE WHEN provisional_phase = 'reserved' THEN FALSE
                                                ELSE provisional_quota_masked END,
               provisional_started_at_ms = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                                 ELSE provisional_started_at_ms END,
               provisional_owner_instance = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                                   ELSE provisional_owner_instance END,
               provisional_owner_host = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                             ELSE provisional_owner_host END,
               provisional_owner_pid = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                            ELSE provisional_owner_pid END,
               provisional_user_id = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                          ELSE provisional_user_id END,
               provisional_generation = CASE WHEN provisional_phase = 'reserved' THEN NULL
                                             ELSE provisional_generation END
         WHERE user_id = OLD.id OR identifier_key IN (old_key, new_key);
      ELSE
        NEW.password_auth_generation := OLD.password_auth_generation;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS password_credential_generation_fence ON users;
    CREATE TRIGGER password_credential_generation_fence BEFORE INSERT OR UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION password_credential_generation_fence();

    CREATE OR REPLACE FUNCTION password_evaluation_retention() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    DECLARE
      now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      cutoff_ms bigint := now_ms - ${windowMs};
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.retained_until_ms > now_ms OR OLD.locked_until_ms > now_ms
           OR OLD.legacy_hold_until_ms > now_ms OR OLD.provisional_operation IS NOT NULL
           OR EXISTS (SELECT 1 FROM unnest(OLD.attempts || OLD.failures || OLD.successes || OLD.uncertain) AS event(ts)
                       WHERE ts > cutoff_ms) THEN
          RETURN NULL;
        END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'INSERT' THEN
        NEW.retained_until_ms := greatest(NEW.retained_until_ms, now_ms + ${windowMs});
      ELSIF current_user = 'control_api_runtime' THEN
        NEW.retained_until_ms := greatest(OLD.retained_until_ms, NEW.retained_until_ms);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS password_evaluation_retention ON password_identifier_state;
    CREATE TRIGGER password_evaluation_retention BEFORE INSERT OR UPDATE OR DELETE
      ON password_identifier_state FOR EACH ROW EXECUTE FUNCTION password_evaluation_retention();

    -- Exact-incarnation, operator-only recovery for an abandoned running identity operation.
    -- It is deliberately not an HTTP/API capability and is never executable by the runtime role.
    CREATE OR REPLACE FUNCTION public.password_reconcile_running_admission(
      p_identifier_key text,
      p_instance uuid,
      p_revision bigint,
      p_operation uuid,
      p_provisional_epoch bigint,
      p_owner_instance uuid,
      p_owner_host text,
      p_owner_pid integer,
      p_disposition text
    ) RETURNS TABLE(reconciliation text, operation_id uuid)
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    DECLARE
      current_row public.password_identifier_state%ROWTYPE;
      now_ms bigint;
      failure_window bigint[];
      success_window bigint[];
      uncertainty_window bigint[];
      next_failures bigint[];
      next_successes bigint[];
      next_uncertain bigint[];
      next_locked_until bigint;
      final_disposition text;
      changed integer;
    BEGIN
      -- Recovery is a security-state transition and must be durable before it is acknowledged.
      PERFORM set_config('synchronous_commit', 'on', true);

      IF p_disposition IS NULL
         OR p_disposition NOT IN ('failure', 'success', 'prestart', 'uncertain') THEN
        RAISE EXCEPTION 'invalid password admission reconciliation'
          USING ERRCODE = '22023';
      END IF;

      SELECT * INTO current_row
        FROM public.password_identifier_state
       WHERE identifier_key = p_identifier_key
       FOR UPDATE;
      IF NOT FOUND OR current_row.instance IS DISTINCT FROM p_instance THEN
        RAISE EXCEPTION 'password admission state instance changed'
          USING ERRCODE = '55000';
      END IF;

      -- A committed terminal receipt is authoritative even when the client lost its ACK.
      -- Return it before examining a newer provisional operation; never debit twice.
      IF current_row.terminal_operation = p_operation THEN
        RETURN QUERY SELECT 'already_terminal'::text, p_operation;
        RETURN;
      END IF;

      IF current_row.revision IS DISTINCT FROM p_revision
         OR current_row.provisional_operation IS DISTINCT FROM p_operation
         OR current_row.provisional_phase IS DISTINCT FROM 'running'
         OR current_row.provisional_epoch IS DISTINCT FROM p_provisional_epoch
         OR current_row.provisional_owner_instance IS DISTINCT FROM p_owner_instance
         OR current_row.provisional_owner_host IS DISTINCT FROM p_owner_host
         OR current_row.provisional_owner_pid IS DISTINCT FROM p_owner_pid THEN
        RAISE EXCEPTION 'password admission operation identity changed'
          USING ERRCODE = '55000';
      END IF;
      IF p_disposition = 'success'
         AND current_row.provisional_scope = 'public_login'
         AND current_row.provisional_quota_masked THEN
        RAISE EXCEPTION 'quota-masked password operation cannot succeed'
          USING ERRCODE = '55000';
      END IF;

      now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      SELECT COALESCE(array_agg(event.ts ORDER BY event.ts), '{}'::bigint[])
        INTO failure_window
        FROM unnest(current_row.failures) AS event(ts)
       WHERE event.ts > now_ms - ${windowMs};
      SELECT COALESCE(array_agg(event.ts ORDER BY event.ts), '{}'::bigint[])
        INTO success_window
        FROM unnest(current_row.successes) AS event(ts)
       WHERE event.ts > now_ms - ${windowMs};
      SELECT COALESCE(array_agg(event.ts ORDER BY event.ts), '{}'::bigint[])
        INTO uncertainty_window
        FROM unnest(current_row.uncertain) AS event(ts)
       WHERE event.ts > now_ms - ${windowMs};

      IF current_row.provisional_epoch IS DISTINCT FROM current_row.revision THEN
        final_disposition := 'stale';
        next_failures := current_row.failures;
        next_successes := current_row.successes;
        next_uncertain := current_row.uncertain;
        next_locked_until := current_row.locked_until_ms;
      ELSE
        final_disposition := CASE p_disposition
          WHEN 'prestart' THEN 'cancelled'
          ELSE p_disposition
        END;
        next_failures := failure_window;
        next_successes := success_window;
        next_uncertain := uncertainty_window;
        IF p_disposition = 'failure' THEN
          next_failures := array_append(next_failures, now_ms);
        ELSIF p_disposition = 'success'
          AND current_row.provisional_scope = 'public_login' THEN
          next_successes := array_append(next_successes, now_ms);
        ELSIF p_disposition = 'uncertain' THEN
          next_uncertain := array_append(next_uncertain, now_ms);
          IF current_row.provisional_scope = 'public_login'
             AND NOT current_row.provisional_quota_masked THEN
            next_successes := array_append(next_successes, now_ms);
          END IF;
        END IF;
        IF p_disposition = 'failure'
           AND cardinality(next_failures) >= ${PASSWORD_ADMISSION_POLICY.failures} THEN
          next_locked_until := greatest(
            current_row.locked_until_ms,
            now_ms + ${PASSWORD_ADMISSION_POLICY.cooldownMs}
          );
        ELSE
          next_locked_until := CASE WHEN current_row.locked_until_ms > now_ms
                                    THEN current_row.locked_until_ms ELSE 0 END;
        END IF;
      END IF;

      UPDATE public.password_identifier_state
         SET failures = next_failures,
             successes = next_successes,
             uncertain = next_uncertain,
             locked_until_ms = next_locked_until,
             retained_until_ms = greatest(retained_until_ms, now_ms + ${windowMs}),
             terminal_operation = p_operation,
             terminal_disposition = final_disposition,
             terminal_at_ms = now_ms,
             terminal_epoch = revision,
             provisional_operation = NULL,
             provisional_phase = NULL,
             provisional_scope = NULL,
             provisional_epoch = NULL,
             provisional_expires_at_ms = NULL,
             provisional_quota_masked = FALSE,
             provisional_started_at_ms = NULL,
             provisional_owner_instance = NULL,
             provisional_owner_host = NULL,
             provisional_owner_pid = NULL,
             provisional_user_id = NULL,
             provisional_generation = NULL
       WHERE identifier_key = p_identifier_key
         AND instance = p_instance
         AND revision = p_revision
         AND provisional_operation = p_operation
         AND provisional_phase = 'running'
         AND provisional_owner_instance = p_owner_instance
         AND provisional_owner_host = p_owner_host
         AND provisional_owner_pid = p_owner_pid;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed <> 1 THEN
        RAISE EXCEPTION 'password admission reconciliation lost its compare-and-set'
          USING ERRCODE = '55000';
      END IF;
      RETURN QUERY SELECT final_disposition, p_operation;
    END $$;
    REVOKE ALL ON FUNCTION public.password_reconcile_running_admission(
      text, uuid, bigint, uuid, bigint, uuid, text, integer, text
    ) FROM PUBLIC, control_api_runtime;

    GRANT SELECT, INSERT, UPDATE, DELETE ON password_identifier_state, password_verification_pace
      TO control_api_runtime;
  `)
  await installPasswordAdmissionRolloutGuards(db)
  await db.query(
    `UPDATE ${PASSWORD_ADMISSION_ROLLOUT_TABLE} SET phase = 'v2' WHERE singleton = TRUE`
  )
}
