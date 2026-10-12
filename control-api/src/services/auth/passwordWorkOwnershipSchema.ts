import type { DbClient } from '../../db.js'

/** Dedicated password authority. Never reclaimed by age, heartbeat or session loss. */
export async function applyPasswordWorkOwnershipSchema(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS password_verification_work (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      operation_id UUID NOT NULL,
      owner_instance UUID NOT NULL,
      owner_host TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    GRANT SELECT, INSERT, DELETE ON password_verification_work TO control_api_runtime;
  `)
}
