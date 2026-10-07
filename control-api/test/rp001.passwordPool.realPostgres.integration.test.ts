import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
const password = 'Synthetic-RP001-correct-password'
const realCompare = bcrypt.compare.bind(bcrypt)
realPg('RP-001 production credential pool ownership', () => {
  let hash: string
  let admin: Pool
  let database: string
  let db: typeof import('../src/db.js') | undefined
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    hash = await bcrypt.hash(password, 12)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    if (db) {
      await endPoolAndWaitForClients(db.pool)
      await endPoolAndWaitForClients(db.rateLimitPool)
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    }
    db = undefined
    vi.unstubAllEnvs()
  })
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
    } finally {
      await admin?.end()
    }
  })
  async function setup(max: number) {
    database = `rp001_${randomBytes(6).toString('hex')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', url.toString())
    vi.stubEnv('CORE_POOL_MAX', String(max))
    vi.stubEnv('CORE_POOL_CONNECTION_TIMEOUT_MS', '200')
    vi.resetModules()
    db = await import('../src/db.js')
    await db.initDb()
    const { rows } = await db.pool.query(
      'INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id',
      ['member@example.invalid', hash]
    )
    const login = await import('../src/services/directory/login.js')
    const engine = await import('../src/services/auth/passwordCredentialVerification.js')
    return { userId: String(rows[0].id), login, engine }
  }
  async function openPace() {
    await db!.pool.query(
      "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
    )
  }
  it.each([1, 2, 10])(
    'authenticates public and Desktop callers with core pool max %i',
    async max => {
      const { userId, login } = await setup(max)
      expect(
        await login.passwordLoginData({ email: 'member@example.invalid', password })
      ).toMatchObject({ user: { id: userId } })
      await openPace()
      expect(
        await login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
      ).toBe(true)
    },
    60_000
  )
  it('admits no queued or overlapping bcrypt while comparison is held', async () => {
    const { userId, login } = await setup(2)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const spy = vi
      .spyOn(bcrypt, 'compare')
      .mockImplementation(async (submitted: string, stored: string) => {
        entered()
        await held
        return realCompare(submitted, stored)
      })
    const first = login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
    try {
      await started
      await openPace()
      await expect(
        login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
      ).rejects.toMatchObject({ status: 429 })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await first
    }
  }, 60_000)
  it('releases capacity after comparison errors and completion errors', async () => {
    const { userId, login } = await setup(1)
    vi.spyOn(bcrypt, 'compare').mockRejectedValueOnce(new Error('synthetic comparison failure'))
    await expect(
      login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
    ).rejects.toMatchObject({ status: 503 })
    await openPace()
    expect(
      await login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
    ).toBe(true)
    await openPace()
    const connect = db!.pool.connect.bind(db!.pool)
    const spy = vi.spyOn(db!.pool, 'connect')
    let completing = false
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (submitted: string, stored: string) => {
      const result = await realCompare(submitted, stored)
      completing = true
      return result
    })
    spy.mockImplementation((...args: unknown[]) => {
      if (completing) {
        completing = false
        return Promise.reject(new Error('synthetic completion failure'))
      }
      return (connect as Function)(...args)
    })
    await expect(
      login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
    ).rejects.toMatchObject({ status: 503 })
    spy.mockRestore()
    vi.restoreAllMocks()
    await openPace()
    expect(
      await login.verifyUserPassword({ userId, email: 'member@example.invalid', password })
    ).toBe(true)
  }, 60_000)
})
