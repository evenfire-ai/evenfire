import { initDb, pool } from './db.js'

async function main(): Promise<void> {
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
    await pool.end()
  })
