import type { DbClient } from '../db.js'

export const OIDC_DESKTOP_SIGN_IN_MIGRATION = '0160_oidc_desktop_sign_in'

/**
 * Desktop browser sign-in tables.
 *
 * `oidc_attempt_sign_in_contexts` records what an OIDC protocol attempt was
 * started for: a Desktop sign-in carries the Desktop's PKCE code challenge,
 * an invitation carries the invitation id and the lower-cased invited email.
 * The context goes with its attempt. `invitation_id` has no foreign key, so an
 * invitation can be revoked or removed while an attempt is pending. The
 * runtime role only inserts and reads contexts.
 *
 * `oidc_desktop_sign_in_codes` holds minted one-use Desktop codes as SHA-256
 * hex hashes, never the code itself. The runtime role inserts, reads and
 * deletes them: redeem is `DELETE … RETURNING` and the purge is a plain
 * `DELETE`, so no statement updates a code row. A code goes with its user;
 * `team_id` has no foreign key.
 */
export async function applyOidcDesktopSignInSchema(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS oidc_attempt_sign_in_contexts (
      attempt_id UUID PRIMARY KEY REFERENCES oidc_protocol_attempts(id) ON DELETE CASCADE,
      context_kind TEXT NOT NULL CHECK (context_kind IN ('desktop_sign_in', 'invitation')),
      desktop_code_challenge TEXT NULL CHECK (desktop_code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
      invitation_id UUID NULL,
      invited_email TEXT NULL CHECK (invited_email = lower(invited_email)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT oidc_attempt_sign_in_contexts_kind_columns CHECK (
        (context_kind = 'desktop_sign_in' AND desktop_code_challenge IS NOT NULL
          AND invitation_id IS NULL AND invited_email IS NULL)
        OR (context_kind = 'invitation' AND desktop_code_challenge IS NULL
          AND invitation_id IS NOT NULL AND invited_email IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS oidc_desktop_sign_in_codes (
      code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id UUID NULL,
      code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
      registration_id TEXT NOT NULL,
      configuration_generation TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS oidc_desktop_sign_in_codes_expiry_idx
      ON oidc_desktop_sign_in_codes (expires_at);

    REVOKE ALL PRIVILEGES ON TABLE oidc_attempt_sign_in_contexts, oidc_desktop_sign_in_codes
      FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE oidc_attempt_sign_in_contexts, oidc_desktop_sign_in_codes
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT ON TABLE oidc_attempt_sign_in_contexts TO control_api_runtime;
    GRANT SELECT, INSERT, DELETE ON TABLE oidc_desktop_sign_in_codes TO control_api_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE oidc_attempt_sign_in_contexts
      FROM control_api_runtime;
    REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON TABLE oidc_desktop_sign_in_codes
      FROM control_api_runtime;
  `)
}
