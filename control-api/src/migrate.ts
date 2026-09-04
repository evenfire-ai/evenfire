import type { Pool } from 'pg'
import { resolveMigrationConnectionString } from './migrationConnection.js'
import { rootLogger } from './observability/logger.js'

let migrationPool: Pool | undefined
const logger = rootLogger.child({ module: 'database-migration-entrypoint' })

async function main(): Promise<void> {
  process.env.CONTROL_API_PG_CONNECTION_STRING = resolveMigrationConnectionString(process.env)
  const { initDb, pool } = await import('./db.js')
  migrationPool = pool
  logger.info('Starting database migration')
  await initDb()
  logger.info('Database migration complete')
}

main()
  .catch(error => {
    logger.error({ err: error }, 'Database migration failed')
    process.exitCode = 1
  })
  .finally(async () => {
    await migrationPool?.end()
  })
