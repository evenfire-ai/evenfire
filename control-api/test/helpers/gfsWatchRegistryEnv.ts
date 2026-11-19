import { randomBytes } from 'node:crypto'

// Imported before anything that reaches src/db.ts: the core pool reads its
// connection string when that module is first evaluated, and the watch
// runtime's static imports reach it. The database itself is created by the
// harness.
export const registryTestDatabase = `control_api_gfs_watch_registry_${randomBytes(6).toString('hex')}`
export const previousCoreConnectionString = process.env.CONTROL_API_PG_CONNECTION_STRING

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
if (adminUrl) {
  const url = new URL(adminUrl)
  url.pathname = `/${registryTestDatabase}`
  process.env.CONTROL_API_PG_CONNECTION_STRING = url.toString()
}
