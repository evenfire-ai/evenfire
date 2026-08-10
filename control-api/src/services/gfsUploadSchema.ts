import type { DbClient } from '../db.js'

/**
 * Additive persistence for the indexed GFS Upload v2 protocol.
 *
 * Session metadata and part receipts live in the control-plane Postgres. Part
 * bytes stay on the existing GFSC writer PVC; `staging_path` is metadata only.
 * The migration is forward-only and deliberately does not advertise or enable
 * the protocol.
 */
export async function applyGfsUploadSessionSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gfs_upload_sessions (
      upload_id UUID PRIMARY KEY,
      idempotency_key UUID NOT NULL,
      drive TEXT NOT NULL,
      owner_subject TEXT NOT NULL,
      primary_subject TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'replace')),
      request_fingerprint TEXT NOT NULL,
      parent_rid TEXT NULL,
      resource_rid TEXT NULL,
      reserved_resource_id UUID NULL,
      resource_name TEXT NULL,
      if_match BIGINT NULL,
      expected_bytes BIGINT NOT NULL CHECK (expected_bytes BETWEEN 0 AND 1073741824),
      part_bytes BIGINT NOT NULL CHECK (part_bytes BETWEEN 1048576 AND 16777216),
      part_count INTEGER NOT NULL CHECK (part_count BETWEEN 0 AND 1024),
      whole_sha256 TEXT NULL,
      committed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
      contiguous_bytes BIGINT NOT NULL DEFAULT 0 CHECK (contiguous_bytes >= 0),
      committed_part_count INTEGER NOT NULL DEFAULT 0 CHECK (committed_part_count >= 0),
      active_part_count INTEGER NOT NULL DEFAULT 0 CHECK (active_part_count >= 0),
      session_epoch BIGINT NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'initiated', 'uploading', 'paused', 'finalizing', 'completed',
        'aborted', 'expired', 'failed'
      )),
      result_resource_id UUID NULL,
      result_version BIGINT NULL,
      result_sha256 TEXT NULL,
      failure_code TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NULL,
      cleanup_at TIMESTAMPTZ NULL,
      CONSTRAINT gfs_upload_sessions_owner_idempotency_unique
        UNIQUE (owner_subject, drive, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS gfs_upload_parts (
      upload_id UUID NOT NULL REFERENCES gfs_upload_sessions(upload_id) ON DELETE CASCADE,
      part_number INTEGER NOT NULL CHECK (part_number >= 0),
      offset_bytes BIGINT NOT NULL CHECK (offset_bytes >= 0),
      length_bytes BIGINT NOT NULL CHECK (length_bytes > 0 AND length_bytes <= 16777216),
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'failed')),
      staging_path TEXT NOT NULL,
      lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 0),
      lease_started_at TIMESTAMPTZ NULL,
      committed_at TIMESTAMPTZ NULL,
      PRIMARY KEY (upload_id, part_number),
      CONSTRAINT gfs_upload_parts_upload_offset_unique UNIQUE (upload_id, offset_bytes)
    );

    CREATE INDEX IF NOT EXISTS gfs_upload_sessions_active_expiry_idx
      ON gfs_upload_sessions (state, expires_at)
      WHERE state IN ('initiated', 'uploading', 'paused', 'finalizing');
    CREATE INDEX IF NOT EXISTS gfs_upload_sessions_owner_state_idx
      ON gfs_upload_sessions (owner_subject, drive, state, updated_at);
    CREATE INDEX IF NOT EXISTS gfs_upload_parts_state_lease_idx
      ON gfs_upload_parts (state, lease_started_at);
    CREATE INDEX IF NOT EXISTS gfs_upload_parts_upload_state_idx
      ON gfs_upload_parts (upload_id, state, part_number);

    REVOKE ALL PRIVILEGES ON TABLE gfs_upload_sessions, gfs_upload_parts FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE gfs_upload_sessions, gfs_upload_parts FROM gfs_controller_reader;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE gfs_upload_sessions, gfs_upload_parts TO gfs_controller;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE gfs_upload_sessions, gfs_upload_parts FROM gfs_controller;
  `)
}

/** Additive follow-up for installations that already applied migration 0091. */
export async function applyGfsUploadCleanupSchema(db: DbClient): Promise<void> {
  await db.query(
    `ALTER TABLE IF EXISTS gfs_upload_sessions ADD COLUMN IF NOT EXISTS cleanup_at TIMESTAMPTZ NULL`
  )
}
