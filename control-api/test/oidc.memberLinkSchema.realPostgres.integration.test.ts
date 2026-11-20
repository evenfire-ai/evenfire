import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('OIDC member link schema on real PostgreSQL', () => {
  const database = `oidc_member_links_${randomBytes(6).toString('hex')}`
  let adminPool: Pool | undefined
  let pool: Pool | undefined

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => pool!.connect() })
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(pool)
      if (adminPool) {
        await adminPool
          .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
          .catch(() => undefined)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function seedLink(connectionId: string, subject: string, userId?: string) {
    const id = userId ?? randomUUID()
    if (!userId) {
      await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@fixture.test`])
    }
    await pool!.query(
      `INSERT INTO oidc_connections (id, issuer, client_id)
       VALUES ($1, 'https://issuer.example.test', 'fixture-client') ON CONFLICT DO NOTHING`,
      [connectionId]
    )
    await pool!.query(
      `INSERT INTO user_oidc_links (connection_id, issuer, subject, user_id)
       VALUES ($1, 'https://issuer.example.test', $2, $3)`,
      [connectionId, subject, id]
    )
    return id
  }

  it('registers 0157 and creates both tables with the contracted columns', async () => {
    expect(CONTROL_API_MIGRATIONS.map(m => m.version)).toContain('0157_oidc_member_links')
    const columns = await pool!.query<{
      table_name: string
      column_name: string
      is_nullable: string
    }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_name IN ('oidc_connections', 'user_oidc_links')
        ORDER BY table_name, column_name`
    )
    expect(columns.rows.map(r => `${r.table_name}.${r.column_name}:${r.is_nullable}`)).toEqual([
      'oidc_connections.client_id:NO',
      'oidc_connections.created_at:NO',
      'oidc_connections.enabled_at:YES',
      'oidc_connections.id:NO',
      'oidc_connections.issuer:NO',
      'oidc_connections.removed_at:YES',
      'user_oidc_links.connection_id:NO',
      'user_oidc_links.created_at:NO',
      'user_oidc_links.issuer:NO',
      'user_oidc_links.subject:NO',
      'user_oidc_links.user_id:NO',
    ])
  })

  it('refuses to delete a linked user (23503)', async () => {
    const userId = await seedLink(`conn-${randomUUID()}`, 'subject-a')
    await expect(pool!.query(`DELETE FROM users WHERE id = $1`, [userId])).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('refuses a duplicate (connection, issuer, subject) and a duplicate (connection, user) (23505)', async () => {
    const connectionId = `conn-${randomUUID()}`
    const userId = await seedLink(connectionId, 'subject-b')
    const other = randomUUID()
    await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      other,
      `${other}@fixture.test`,
    ])
    await expect(seedLink(connectionId, 'subject-b', other)).rejects.toMatchObject({
      code: '23505',
    })
    await expect(seedLink(connectionId, 'subject-c', userId)).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('grants the runtime role UPDATE on connections and only SELECT/INSERT on links', async () => {
    const privilege = async (table: string, kind: string) =>
      (
        await pool!.query<{ ok: boolean }>(
          `SELECT has_table_privilege('control_api_runtime', $1, $2) AS ok`,
          [table, kind]
        )
      ).rows[0]!.ok
    expect(await privilege('oidc_connections', 'UPDATE')).toBe(true)
    expect(await privilege('user_oidc_links', 'SELECT')).toBe(true)
    expect(await privilege('user_oidc_links', 'INSERT')).toBe(true)
    expect(await privilege('user_oidc_links', 'UPDATE')).toBe(false)
    expect(await privilege('user_oidc_links', 'DELETE')).toBe(false)
  })
})
