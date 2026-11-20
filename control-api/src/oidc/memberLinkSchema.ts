import type { DbClient } from '../db.js'

/**
 * OIDC member sign-in tables. `oidc_connections` records which issuer and
 * client a link was made under; `user_oidc_links` binds a provider subject to
 * an Evenfire user within one connection. Links are append-only for the
 * runtime role, and neither a connection nor a user can be deleted while a
 * link references it.
 */
export async function applyOidcMemberLinkSchema(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS oidc_connections (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      client_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      enabled_at TIMESTAMPTZ NULL,
      removed_at TIMESTAMPTZ NULL
    );

    CREATE TABLE IF NOT EXISTS user_oidc_links (
      connection_id TEXT NOT NULL REFERENCES oidc_connections(id) ON DELETE RESTRICT,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, issuer, subject),
      UNIQUE (connection_id, user_id)
    );

    REVOKE ALL PRIVILEGES ON TABLE oidc_connections, user_oidc_links FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE oidc_connections, user_oidc_links
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE oidc_connections TO control_api_runtime;
    GRANT SELECT, INSERT ON TABLE user_oidc_links TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE oidc_connections FROM control_api_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE user_oidc_links FROM control_api_runtime;
  `)
}
