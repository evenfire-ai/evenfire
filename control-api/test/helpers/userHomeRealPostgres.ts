import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../../src/db.js'
import { endPoolAndWaitForClients } from './realPostgresTeardown.js'

export async function createUserHomeDatabase(adminUrl: string, admin: Pool) {
  const database = `gfs_home_s2_${randomBytes(6).toString('hex')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  let pool: Pool | undefined
  try {
    const url = new URL(adminUrl)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString(), max: 8, statement_timeout: 10_000 })
    await initDb({ connect: () => pool!.connect() })
  } catch (error) {
    try {
      await endPoolAndWaitForClients(pool)
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database]
      )
      await admin.query(`DROP DATABASE "${database}"`)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'User-home database setup and cleanup failed')
    }
    throw error
  }
  return {
    pool,
    database,
    async closeConnections() {
      await endPoolAndWaitForClients(pool)
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database]
      )
    },
  }
}

export async function createDrive(pool: Pool, drive: string): Promise<string> {
  const result = await pool.query<{ resource_id: string }>(
    `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
     VALUES ($1, NULL, '', 'directory', '/') RETURNING resource_id`,
    [drive]
  )
  return result.rows[0]!.resource_id
}

export async function createUser(pool: Pool, name = 'Home User'): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
    id,
    `${id}@example.test`,
    name,
  ])
  return id
}

export async function homeState(pool: Pool, userId: string) {
  const result = await pool.query<{
    state: string
    drive: string | null
    storage_username: string | null
    resource_id: string | null
    conflict_code: string | null
    attempts: number
    last_error: string | null
  }>('SELECT * FROM gfs_user_homes WHERE user_id = $1', [userId])
  return result.rows[0]
}
