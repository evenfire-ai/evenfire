import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
realPg('RP-1010-05 authenticated principal binding', () => {
  const database = `rp005_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let db: typeof import('../src/db.js')
  let login: typeof import('../src/services/directory/login.js')
  let firstId: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', url.toString())
    vi.resetModules()
    db = await import('../src/db.js')
    await db.initDb()
    login = await import('../src/services/directory/login.js')
    const hash = await bcrypt.hash('Synthetic-RP005-password', 12)
    firstId = String(
      (
        await db.pool.query('INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id', [
          'first@example.invalid',
          hash,
        ])
      ).rows[0].id
    )
    await db.pool.query('INSERT INTO users(email,password_hash) VALUES ($1,$2)', [
      'second@example.invalid',
      hash,
    ])
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.pool.query('TRUNCATE password_identifier_state, password_verification_pace')
  })
  afterAll(async () => {
    try {
      if (db) {
        await endPoolAndWaitForClients(db.pool)
        await endPoolAndWaitForClients(db.rateLimitPool)
      }
      if (admin) await admin.query(`DROP DATABASE "${database}"`)
    } finally {
      await admin?.end()
      vi.unstubAllEnvs()
    }
  })
  it('rejects an inconsistent ID/email without changing either principal or expensive-work state', async () => {
    expect(
      await login.verifyUserPassword({
        userId: firstId,
        email: 'second@example.invalid',
        password: 'incorrect',
      })
    ).toBe(false)
    expect((await db.pool.query('SELECT * FROM password_identifier_state')).rows).toEqual([])
    expect((await db.pool.query('SELECT * FROM password_verification_pace')).rows).toEqual([])
  })
  it.each(['second@example.invalid', 'unknown@example.invalid'])(
    'rejects an empty authenticated ID for %s without state effects',
    async submitted => {
      const compare = vi.spyOn(bcrypt, 'compare')
      expect(
        await login.verifyUserPassword({
          userId: ' ',
          email: submitted,
          password: 'Synthetic-RP005-password',
        })
      ).toBe(false)
      expect(compare).not.toHaveBeenCalled()
      expect((await db.pool.query('SELECT * FROM password_identifier_state')).rows).toEqual([])
      expect((await db.pool.query('SELECT * FROM password_verification_pace')).rows).toEqual([])
    }
  )
  it('leaves existing retained security state unchanged on a mismatched binding', async () => {
    const engine = await import('../src/services/auth/passwordCredentialVerification.js')
    const capture = await engine.capturePasswordEvaluation('second@example.invalid', false)
    await engine.completePasswordEvaluation(capture, false)
    const before = (await db.pool.query('SELECT * FROM password_identifier_state')).rows
    expect(
      await login.verifyUserPassword({
        userId: firstId,
        email: 'second@example.invalid',
        password: 'incorrect',
      })
    ).toBe(false)
    expect((await db.pool.query('SELECT * FROM password_identifier_state')).rows).toEqual(before)
    expect((await db.pool.query('SELECT * FROM password_verification_pace')).rows).toEqual([])
  })
  it('preserves same-principal failure charging and successful canonical reverification', async () => {
    expect(
      await login.verifyUserPassword({
        userId: firstId,
        email: 'first@example.invalid',
        password: 'incorrect',
      })
    ).toBe(false)
    expect(
      (await db.pool.query('SELECT attempts,failures FROM password_identifier_state')).rows[0]
    ).toMatchObject({ attempts: [] })
    expect(
      (await db.pool.query('SELECT failures FROM password_identifier_state')).rows[0].failures
    ).toHaveLength(1)
    await db.pool.query(
      "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 second'"
    )
    expect(
      await login.verifyUserPassword({
        userId: firstId,
        email: ' FIRST@example.invalid ',
        password: 'Synthetic-RP005-password',
      })
    ).toBe(true)
    expect(
      (
        await db.pool.query(
          'SELECT attempts,failures,locked_until_ms FROM password_identifier_state'
        )
      ).rows[0]
    ).toMatchObject({ attempts: [], failures: [], locked_until_ms: '0' })
  })
})
