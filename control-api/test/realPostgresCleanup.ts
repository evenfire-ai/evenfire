import type { Pool } from 'pg'

export async function waitForDatabaseConnectionsToClose(
  adminPool: Pool,
  database: string
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await adminPool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = $1 LIMIT 1`,
      [database]
    )
    if (result.rowCount === 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  throw new Error('test database still has PostgreSQL connections after its pool shut down')
}
