import type { Pool } from 'pg'
import { resolveMigrationConnectionString } from './migrationConnection.js'

let migrationPool: Pool | undefined

async function main(): Promise<void> {
  process.env.CONTROL_API_PG_CONNECTION_STRING = resolveMigrationConnectionString(process.env)
  const { initDb, pool } = await import('./db.js')
  migrationPool = pool
  console.log('[ControlAPI:Migrate] Starting DB migration')
  await initDb()
  console.log('[ControlAPI:Migrate] DB migration complete')
}

main()
  .catch(error => {
    console.error('[ControlAPI:Migrate] Fatal error:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await migrationPool?.end()
  })
