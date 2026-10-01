import type { Database } from 'better-sqlite3'

export const name = '016-canonical-store-identity'
/** The init migrator inserts the bound identity before the normal writer opens SQLite. */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE canonical_store_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      store_id TEXT NOT NULL UNIQUE,
      layout_version INTEGER NOT NULL CHECK (layout_version = 1),
      host_uid TEXT NOT NULL,
      pvc_uid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provenance TEXT NOT NULL
    );
    CREATE TRIGGER canonical_store_identity_no_update
      BEFORE UPDATE ON canonical_store_identity BEGIN SELECT RAISE(ABORT, 'immutable canonical store identity'); END;
    CREATE TRIGGER canonical_store_identity_no_delete
      BEFORE DELETE ON canonical_store_identity BEGIN SELECT RAISE(ABORT, 'immutable canonical store identity'); END;
  `)
}
export function down(_db: Database): void {
  throw new Error('Canonical identity is permanent; use a compatible rollback release')
}
