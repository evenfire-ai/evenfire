import type { DbClient } from '../../db.js'

/**
 * Additive persistence foundation for user-session v2: the session rows, the
 * per-user security epochs that invalidate sessions issued before a password
 * event, and the append-only ledger of revoked v1 session tokens.
 */
export async function applyUserAccessFoundationSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS external_user_sessions (
      sid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
      current_jti UUID NOT NULL,
      current_issued_at TIMESTAMPTZ NOT NULL,
      prior_jti UUID,
      prior_jti_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      idle_expires_at TIMESTAMPTZ NOT NULL,
      absolute_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revocation_reason TEXT,
      authentication_methods TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      authenticated_at TIMESTAMPTZ NOT NULL,
      CHECK (idle_expires_at <= absolute_expires_at),
      CHECK (
        (prior_jti IS NULL AND prior_jti_expires_at IS NULL)
        OR (prior_jti IS NOT NULL AND prior_jti_expires_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS external_user_sessions_user_live_idx
      ON external_user_sessions (user_id, absolute_expires_at, idle_expires_at)
      WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS external_user_sessions_idle_idx
      ON external_user_sessions (idle_expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS external_user_session_security_epochs (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      valid_after TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS external_v1_session_revocations (
      token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS external_v1_session_revocations_user_idx
      ON external_v1_session_revocations (user_id, expires_at);
    CREATE INDEX IF NOT EXISTS external_v1_session_revocations_expiry_idx
      ON external_v1_session_revocations (expires_at);
  `)
  // Indexes on tables that exist before PR1 are built online by
  // PR1_ONLINE_INDEX_PLAN before this transaction opens, so this transaction
  // takes no ShareLock on those tables.

  await applyUserAccessRuntimePrivileges(db)
}

export async function backfillLegacyPasswordSecurityEpochs(db: DbClient): Promise<void> {
  await db.query(`
    INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason, updated_at)
    SELECT u.id, u.password_set_at, 'historical_password_event', u.password_set_at
      FROM users u
     WHERE u.password_set_at IS NOT NULL
    ON CONFLICT (user_id) DO UPDATE
      SET valid_after = GREATEST(
            external_user_session_security_epochs.valid_after,
            EXCLUDED.valid_after
          ),
          reason = CASE
            WHEN external_user_session_security_epochs.valid_after < EXCLUDED.valid_after
              THEN EXCLUDED.reason
            ELSE external_user_session_security_epochs.reason
          END,
          updated_at = CASE
            WHEN external_user_session_security_epochs.valid_after < EXCLUDED.valid_after
              THEN EXCLUDED.updated_at
            ELSE external_user_session_security_epochs.updated_at
          END;
  `)
}

async function applyUserAccessRuntimePrivileges(db: DbClient): Promise<void> {
  await db.query(`
    REVOKE ALL PRIVILEGES ON TABLE
      external_user_sessions,
      external_user_session_security_epochs,
      external_v1_session_revocations
      FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime;

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE external_user_sessions TO control_api_runtime;

    -- The runtime never deletes an epoch. The user-deletion cascade runs as the table owner.
    GRANT SELECT, INSERT, UPDATE ON TABLE external_user_session_security_epochs
      TO control_api_runtime;

    -- Append-only ledger: the runtime records a revocation but never rewrites or
    -- erases one. The user-deletion cascade runs as the table owner.
    GRANT SELECT, INSERT ON TABLE external_v1_session_revocations TO control_api_runtime;
  `)
}
