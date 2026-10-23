import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
const password = 'Synthetic-RP004-correct-password'
const email = 'owner@example.invalid'

// Both processes execute the source producer and real cost-12 bcrypt. No built artifacts required.
const childScript = `
require('ts-node').register({project:'./tsconfig.json',experimentalResolver:true,transpileOnly:true});
const bcrypt=require('bcryptjs');
const compare=bcrypt.compare.bind(bcrypt);
// Isolated fault harness keeps the owner alive after its idle pool reports session termination.
require('./src/db.ts').pool.on('error',()=>{});
bcrypt.compare=async (...args)=>{
  const work=compare(...args);
  process.send({kind:'entered'});
  if(process.env.PAUSE_COMPARISON==='1') process.kill(process.pid,'SIGSTOP');
  return work;
};
const {verifyMemberPassword}=require('./src/services/auth/passwordCredentialVerification.ts');
verifyMemberPassword(process.env.TEST_EMAIL,process.env.TEST_PASSWORD,{publicLogin:false})
 .then(user=>process.send({kind:'result',success:!!user},()=>process.exit(0)),
 error=>process.send({kind:'result',status:error.status},()=>process.exit(0)));
`

realPg('RP-1010-04 durable expensive-work ownership', () => {
  const database = `rp004_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let db: typeof import('../src/db.js')
  let url: URL
  const children = new Set<ChildProcess>()
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    url = new URL(adminUrl!)
    url.pathname = `/${database}`
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', url.toString())
    vi.resetModules()
    db = await import('../src/db.js')
    await db.initDb()
    await db.pool.query('INSERT INTO users(email,password_hash) VALUES ($1,$2)', [
      email,
      await bcrypt.hash(password, 12),
    ])
  }, 60_000)
  beforeEach(async () => {
    await db.pool.query('TRUNCATE password_identifier_state, password_verification_pace')
    if (
      (await db.pool.query("SELECT to_regclass('password_verification_work') AS present")).rows[0]
        .present
    )
      await db.pool.query('DELETE FROM password_verification_work')
  })
  afterAll(async () => {
    try {
      for (const child of children) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        child.kill('SIGCONT')
        child.kill('SIGKILL')
        await exited
      }
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

  function start(paused: boolean) {
    const name = `rp004_${randomBytes(5).toString('hex')}`
    const childUrl = new URL(url)
    childUrl.searchParams.set('application_name', name)
    const child = spawn(process.execPath, ['-e', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTROL_API_PG_CONNECTION_STRING: childUrl.toString(),
        TEST_EMAIL: email,
        TEST_PASSWORD: password,
        PAUSE_COMPARISON: paused ? '1' : '0',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.add(child)
    const messages: Array<{ kind: string; success?: boolean; status?: number }> = []
    let notify = () => {}
    child.on('message', value => {
      messages.push(value as (typeof messages)[number])
      notify()
    })
    let stderr = ''
    child.stderr!.on('data', value => {
      stderr += String(value)
    })
    const exited = new Promise<number | null>(resolve =>
      child.once('exit', code => {
        children.delete(child)
        resolve(code)
        notify()
      })
    )
    async function wait(kind: string) {
      const deadline = Date.now() + 20_000
      while (!messages.some(value => value.kind === kind)) {
        if (!children.has(child)) throw new Error(`producer exited before ${kind}: ${stderr}`)
        if (Date.now() >= deadline) throw new Error(`producer timeout: ${kind}`)
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 50)
          notify = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
      return messages.find(value => value.kind === kind)!
    }
    return { child, name, wait, exited }
  }
  it('does not admit replacement bcrypt after the paused owner loses all database sessions', async () => {
    const first = start(true)
    try {
      await first.wait('entered')
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
        [first.name]
      )
      // Natural pace expiry; do not pre-open/reset next_permit and mask the reported scenario.
      await new Promise(resolve => setTimeout(resolve, 7_600))
      const second = start(false)
      const result = await second.wait('result')
      expect(result).toMatchObject({ status: 429 })
      expect(await second.exited).toBe(0)
    } finally {
      first.child.kill('SIGCONT')
      await first.wait('result')
      expect(await first.exited).toBe(0)
    }
  }, 60_000)
  it('admits exactly one competing owner and releases idempotently', async () => {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const leases = await Promise.all(Array.from({ length: 8 }, () => acquirePasswordWork()))
    expect(leases.filter(Boolean)).toHaveLength(1)
    await Promise.all([leases.find(Boolean)!.release(), leases.find(Boolean)!.release()])
    expect((await db.pool.query('SELECT * FROM password_verification_work')).rows).toHaveLength(0)
  })
  it('never reclaims aged work through password or legacy bucket cleanup', async () => {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const lease = await acquirePasswordWork()
    await db.pool.query(
      "UPDATE password_verification_work SET acquired_at=clock_timestamp()-interval '1 day'"
    )
    const { cleanupExpiredBuckets } = await import('../src/services/rateLimiterService.js')
    await cleanupExpiredBuckets()
    expect(await acquirePasswordWork()).toBeNull()
    await lease!.release()
  })
  it('does not release a newer owner with an old operation token', async () => {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const old = await acquirePasswordWork()
    // Fault seam: no bcrypt was started; emulate an authorized recovery/replacement.
    await db.pool.query('DELETE FROM password_verification_work')
    const current = await acquirePasswordWork()
    await expect(old!.release()).rejects.toThrow('ownership lost')
    expect(await acquirePasswordWork()).toBeNull()
    await current!.release()
  })
  it('retains ownership when release persistence is unavailable', async () => {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const lease = await acquirePasswordWork()
    const fault = vi
      .spyOn(db, 'withTransaction')
      .mockRejectedValueOnce(new Error('synthetic unavailable'))
    try {
      await expect(lease!.release()).rejects.toThrow('synthetic unavailable')
    } finally {
      fault.mockRestore()
    }
    expect(await acquirePasswordWork()).toBeNull()
    expect((await db.pool.query('SELECT * FROM password_verification_work')).rows).toHaveLength(1)
  })
  it('denies busy work without bcrypt or a pace refund', async () => {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const engine = await import('../src/services/auth/passwordCredentialVerification.js')
    const lease = await acquirePasswordWork()
    const compare = vi.spyOn(bcrypt, 'compare')
    try {
      await expect(
        engine.verifyMemberPassword(email, password, { publicLogin: false })
      ).rejects.toMatchObject({ status: 429 })
      expect(compare).not.toHaveBeenCalled()
      expect(
        (
          await db.pool.query(
            'SELECT next_permit > clock_timestamp() AS consumed FROM password_verification_pace'
          )
        ).rows[0].consumed
      ).toBe(true)
    } finally {
      compare.mockRestore()
      await lease!.release()
    }
  })
  it('keeps a crashed process reservation until verified recovery', async () => {
    const first = start(true)
    await first.wait('entered')
    first.child.kill('SIGKILL')
    await first.exited
    await new Promise(resolve => setTimeout(resolve, 7_600))
    const next = start(false)
    expect(await next.wait('result')).toMatchObject({ status: 429 })
    expect(await next.exited).toBe(0)
    expect((await db.pool.query('SELECT * FROM password_verification_work')).rows).toHaveLength(1)
    // Test owns and has observed termination of every producer; recover only that observed token.
    const row = (
      await db.pool.query('SELECT operation_id,owner_instance FROM password_verification_work')
    ).rows[0]
    await db.pool.query(
      'DELETE FROM password_verification_work WHERE operation_id=$1 AND owner_instance=$2',
      [row.operation_id, row.owner_instance]
    )
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const recovered = await acquirePasswordWork()
    expect(recovered).not.toBeNull()
    await recovered!.release()
  }, 60_000)
  it('applies the forward ownership schema idempotently without clearing work', async () => {
    const { acquirePasswordWork } = await import('../src/services/auth/passwordWorkOwnership.js')
    const lease = await acquirePasswordWork()
    const { applyPasswordWorkOwnershipSchema } =
      await import('../src/services/auth/passwordWorkOwnershipSchema.js')
    await applyPasswordWorkOwnershipSchema(db.pool)
    await applyPasswordWorkOwnershipSchema(db.pool)
    expect(await acquirePasswordWork()).toBeNull()
    await lease!.release()
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM schema_migrations WHERE version='0128_password_work_ownership'"
        )
      ).rows
    ).toHaveLength(1)
  })
})
