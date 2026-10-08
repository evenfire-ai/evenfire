import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import { applyPasswordAdmissionSchema } from '../src/services/auth/passwordAdmissionSchema.js'
import {
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
} from '../src/services/auth/passwordAdmissionState.js'
import {
  capturePasswordEvaluation,
  cleanupPasswordIdentifierState,
  completePasswordEvaluation,
  reservePasswordPace,
  verifyMemberPassword,
} from '../src/services/auth/passwordCredentialVerification.js'
import { acquirePasswordWork } from '../src/services/auth/passwordWorkOwnership.js'
import {
  acceptInvitationForEmail,
  createInvitationForTeams,
  createSilentInvitationForTeams,
  getInvitationByToken,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
  updateUserPassword,
} from '../src/services/directory/membership.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({
  pool: null as unknown as Pool,
  leaseClient: null as unknown as import('pg').PoolClient,
}))
const invitationFlow = vi.hoisted(() => ({
  registerAndSendInvitation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => invitationFlow)
vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  const proxy = {
    query: (...args: unknown[]) => (holder.pool.query as Function)(...args),
    connect: () => holder.pool.connect(),
  }
  return {
    ...real,
    pool: proxy,
    rateLimitPool: proxy,
    withTransaction: (fn: Parameters<typeof real.withTransaction>[0]) =>
      real.withTransaction(fn, holder.pool),
  }
})
vi.mock('../src/services/rateLimiterService.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/services/rateLimiterService.js')>()
  return {
    ...real,
    acquireRateLimitConcurrencyLease: (
      r: Parameters<typeof real.acquireRateLimitConcurrencyLease>[0]
    ) => real.acquireRateLimitConcurrencyLease(r, { client: holder.leaseClient }),
  }
})
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const realPg = adminUrl ? describe : describe.skip
realPg('Spec 043 persistence, migration, atomicity and fencing design acceptance', () => {
  const database = `bug192_design_${randomBytes(6).toString('hex')}`
  const email = 'member@example.invalid',
    password = 'Synthetic-BUG192-correct-password'
  let admin: Pool, userId: string, hash: string, connectionString: string
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    connectionString = url.toString()
    holder.pool = new Pool({ connectionString })
    await initDb(holder.pool)
    holder.leaseClient = await holder.pool.connect()
    hash = await bcrypt.hash(password, 12)
  }, 60_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    invitationFlow.registerAndSendInvitation.mockReset().mockResolvedValue(undefined)
    await holder.pool.query('DELETE FROM users')
    await holder.pool.query('UPDATE password_identifier_state SET retained_until_ms=0')
    await holder.pool.query('DELETE FROM password_identifier_state')
    await holder.pool.query('DELETE FROM password_verification_pace')
    userId = (
      await holder.pool.query(
        'INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id',
        [email, hash]
      )
    ).rows[0].id
  })
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
      holder.leaseClient?.release()
      await endPoolAndWaitForClients(holder.pool)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })
  async function now() {
    return Number(
      (
        await holder.pool.query(
          'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms'
        )
      ).rows[0].ms
    )
  }
  async function row() {
    return (
      await holder.pool.query('SELECT * FROM password_identifier_state WHERE identifier_key=$1', [
        passwordIdentifierKey(email),
      ])
    ).rows[0]
  }
  async function completedFailures(n = 5) {
    for (let i = 0; i < n; i++) {
      const c = await capturePasswordEvaluation(email, false)
      expect(await completePasswordEvaluation(c, false)).toBe(true)
    }
  }

  it('forward migration is idempotent and grants runtime access', async () => {
    await applyPasswordAdmissionSchema(holder.pool)
    const permissions = (
      await holder.pool.query(
        "SELECT has_table_privilege('control_api_runtime','password_identifier_state','SELECT,INSERT,UPDATE,DELETE') AS state, has_table_privilege('control_api_runtime','password_verification_pace','SELECT,INSERT,UPDATE,DELETE') AS pace"
      )
    ).rows[0]
    expect(permissions).toEqual({ state: true, pace: true })
    const migrations = (
      await holder.pool.query(
        "SELECT version FROM schema_migrations WHERE version='0126_bug192_password_admission'"
      )
    ).rows
    expect(migrations).toHaveLength(1)
  })
  it('serializes competing identifier attempts to exactly five admissions', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => capturePasswordEvaluation(email, true))
    )
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5)
    expect((await row()).attempts).toHaveLength(5)
    const before = await row()
    for (let i = 0; i < 3; i++)
      await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(before)
  })
  it('fifth failure sets one cooldown from DB completion time without extension', async () => {
    await completedFailures(4)
    const before = await now()
    const c = await capturePasswordEvaluation(email, false)
    await completePasswordEvaluation(c, false)
    const after = await now()
    const state = await row()
    expect(Number(state.locked_until_ms)).toBeGreaterThanOrEqual(before + policy.cooldownMs)
    expect(Number(state.locked_until_ms)).toBeLessThanOrEqual(after + policy.cooldownMs)
    for (let i = 0; i < 4; i++)
      await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(state)
  })
  it('active attempt budget and staggered cooldown have real/shadow equivalent retry state', async () => {
    const shadow = 'shadow@example.invalid'
    const t = await now()
    for (const identity of [email, shadow]) {
      await capturePasswordEvaluation(identity, false)
      await holder.pool.query(
        'UPDATE password_identifier_state SET attempts=$2,failures=$2,locked_until_ms=$3 WHERE identifier_key=$1',
        [
          passwordIdentifierKey(identity),
          [t - 1000000, t - 850000, t - 800000, t - 750000, t - 700000],
          t + 200000,
        ]
      )
    }
    const outcomes = await Promise.all(
      [email, shadow].map(identity =>
        capturePasswordEvaluation(identity, true).catch(e => ({
          status: e.status,
          retryAfterSeconds: e.retryAfterSeconds,
        }))
      )
    )
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]).toMatchObject({ status: 429 })
  })
  it('attempt budget exhaustion ends naturally despite repeated denied requests', async () => {
    for (let i = 0; i < 5; i++) await capturePasswordEvaluation(email, true)
    const state = await row()
    await expect(capturePasswordEvaluation(email, true)).rejects.toMatchObject({ status: 429 })
    expect(await row()).toEqual(state)
    const t = await now()
    await holder.pool.query(
      'UPDATE password_identifier_state SET attempts=$2 WHERE identifier_key=$1',
      [passwordIdentifierKey(email), [t - policy.windowMs - 1]]
    )
    await expect(capturePasswordEvaluation(email, true)).resolves.toBeDefined()
    expect((await row()).attempts).toHaveLength(1)
  })
  it('natural cooldown expiry removes stale failures without extending attempts', async () => {
    await completedFailures()
    const t = await now()
    await holder.pool.query(
      'UPDATE password_identifier_state SET locked_until_ms=$2,failures=$3 WHERE identifier_key=$1',
      [passwordIdentifierKey(email), t - 1, [t - policy.windowMs - 1]]
    )
    await capturePasswordEvaluation(email, false)
    expect(await row()).toMatchObject({ locked_until_ms: '0', failures: [] })
  })
  it('successful authentication/reverification clears failures but retains public attempt history', async () => {
    const failed = await capturePasswordEvaluation(email, true)
    await completePasswordEvaluation(failed, false)
    expect(
      await verifyMemberPassword(email, password, { publicLogin: false, userId })
    ).toMatchObject({ id: userId })
    const state = await row()
    expect(state.failures).toEqual([])
    expect(state.locked_until_ms).toBe('0')
    expect(state.attempts).toHaveLength(1)
  })
  it('successful completion fences an older failure completion on the same credential', async () => {
    const older = await capturePasswordEvaluation(email, false),
      successful = await capturePasswordEvaluation(email, false)
    expect(await completePasswordEvaluation(successful, true)).toBe(true)
    expect(await completePasswordEvaluation(older, false)).toBe(false)
    expect((await row()).failures).toEqual([])
  })
  it('real password-change producer fences stale failure and success results', async () => {
    const failure = await capturePasswordEvaluation(email, false),
      success = await capturePasswordEvaluation(email, false)
    expect(
      await updateUserPassword(userId, email, password, 'Synthetic-BUG192-new-password')
    ).toEqual({ updated: true })
    expect(await completePasswordEvaluation(failure, false)).toBe(false)
    expect(await completePasswordEvaluation(success, true)).toBe(false)
    expect((await row()).failures).toEqual([])
  })
  it('prevents a stale authenticated password change from overwriting verified recovery', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    let resolveCompareEntered!: () => void
    let releaseCompare!: () => void
    const compareEntered = new Promise<void>(resolve => {
      resolveCompareEntered = resolve
    })
    const continueCompare = new Promise<void>(resolve => {
      releaseCompare = resolve
    })
    const originalCompare = bcrypt.compare.bind(bcrypt)
    let paused = false
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (candidate, encoded) => {
      const matches = await originalCompare(candidate, encoded)
      if (!paused) {
        paused = true
        resolveCompareEntered()
        await continueCompare
      }
      return matches
    })

    const stalePasswordChange = updateUserPassword(
      userId,
      email,
      password,
      'Synthetic-BUG192-stale-password-change'
    )
    await compareEntered
    const recoveryPassword = 'Synthetic-BUG192-recovered-password'
    const recovery = await setInvitationPasswordForEmail(email, invitation.id, recoveryPassword)
    expect(recovery).not.toHaveProperty('error')

    releaseCompare()
    await expect(stalePasswordChange).resolves.toEqual({ error: 'credential_changed' })
    await expect(
      verifyMemberPassword(email, recoveryPassword, { publicLogin: false, userId })
    ).resolves.toMatchObject({ id: userId })
    const finalHash = (
      await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
    ).rows[0].password_hash
    await expect(bcrypt.compare('Synthetic-BUG192-stale-password-change', finalHash)).resolves.toBe(
      false
    )
  })
  it('real reset/establishment producer clears cooldown and fences old work', async () => {
    const stale = await capturePasswordEvaluation(email, false)
    await completedFailures()
    // Database producer for a pending reset; the real reset function owns the
    // credential write/acceptance and its generation trigger in one transaction.
    const invitation = (
      await holder.pool.query(
        "INSERT INTO invitations(email,role,purpose,status) VALUES ($1,'member','password_reset','pending') RETURNING id",
        [email]
      )
    ).rows[0]
    const result = await setInvitationPasswordForEmail(
      email,
      invitation.id,
      'Synthetic-BUG192-reset-password'
    )
    expect(result).not.toHaveProperty('error')
    expect(await completePasswordEvaluation(stale, false)).toBe(false)
    expect(await row()).toMatchObject({ failures: [], locked_until_ms: '0' })
    const credential = (
      await holder.pool.query('SELECT password_hash FROM users WHERE id=$1', [userId])
    ).rows[0]
    expect(bcrypt.getRounds(credential.password_hash)).toBe(12)
  })
  it('completes authenticated reset with a one-connection PostgreSQL pool', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const previousPool = holder.pool
    const singleConnectionPool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2500,
    })
    holder.pool = singleConnectionPool
    try {
      const result = await setInvitationPasswordForUser(
        userId,
        email,
        invitation.id,
        'Synthetic-BUG192-single-pool-reset'
      )
      expect(result).not.toHaveProperty('error')
      const after = (
        await singleConnectionPool.query(
          'SELECT password_hash, password_auth_generation FROM users WHERE id = $1',
          [userId]
        )
      ).rows[0]
      expect(after.password_hash).not.toBe(hash)
      expect(Number(after.password_auth_generation)).toBeGreaterThan(1)
      expect(
        (
          await singleConnectionPool.query('SELECT status FROM invitations WHERE id = $1', [
            invitation.id,
          ])
        ).rows[0].status
      ).toBe('accepted')
    } finally {
      holder.pool = previousPool
      await endPoolAndWaitForClients(singleConnectionPool)
    }
  })
  it('does not accept a pending password-reset link through generic invitation acceptance', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })

    await expect(acceptInvitationForEmail(email, '', invitation.id)).resolves.toEqual({
      error: 'not_pending',
    })
    expect(
      (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
        .rows[0].status
    ).toBe('pending')
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).toBe(hash)
  })
  it('revokes every other pending password-reset link for the same account only', async () => {
    const makeReset = (address: string) =>
      createSilentInvitationForTeams({
        inviteeName: 'Synthetic member',
        email: address,
        purpose: 'password_reset',
        teamAssignments: [],
        fallbackRole: 'member',
      })
    const redeemed = await makeReset(email)
    const sibling = await makeReset(email)
    await expect(getInvitationByToken(redeemed.token)).resolves.toMatchObject({
      id: redeemed.id,
      purpose: 'password_reset',
      status: 'pending',
    })
    const otherEmail = 'other-member@example.invalid'
    await holder.pool.query('INSERT INTO users(email) VALUES ($1)', [otherEmail])
    const otherMember = await makeReset(otherEmail)
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation

    const result = await setInvitationPasswordForEmail(
      email,
      redeemed.id,
      'Synthetic-BUG192-recovered-password'
    )

    expect(result).not.toHaveProperty('error')
    const rows = (
      await holder.pool.query(
        'SELECT id, email, purpose, status FROM invitations WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[redeemed.id, sibling.id, otherMember.id]]
      )
    ).rows
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: redeemed.id,
          email,
          purpose: 'password_reset',
          status: 'accepted',
        }),
        expect.objectContaining({
          id: sibling.id,
          email,
          purpose: 'password_reset',
          status: 'revoked',
        }),
        expect.objectContaining({
          id: otherMember.id,
          email: otherEmail,
          purpose: 'password_reset',
          status: 'pending',
        }),
      ])
    )
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    const replayHash = vi.spyOn(bcrypt, 'hash')
    await expect(
      setInvitationPasswordForEmail(email, redeemed.id, 'Synthetic-BUG192-used-link-replay')
    ).resolves.toMatchObject({ error: 'not_pending' })
    await expect(
      setInvitationPasswordForEmail(email, sibling.id, 'Synthetic-BUG192-replay-password')
    ).resolves.toMatchObject({ error: 'not_pending' })
    expect(replayHash).not.toHaveBeenCalled()
    expect(
      Number(
        (
          await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [
            userId,
          ])
        ).rows[0].password_auth_generation
      )
    ).toBe(Number(after))
  })

  it('maps the email producer token to its distinct recovery row ID', async () => {
    const invitation = await createInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    expect(invitationFlow.registerAndSendInvitation).toHaveBeenCalledWith(
      email,
      invitation.token,
      null,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ purpose: 'password_reset' })
    )
    expect(invitation.token).toBeTruthy()
    expect(invitation.token).not.toBe(invitation.id)

    const preview = await getInvitationByToken(invitation.token)
    expect(preview).toMatchObject({
      id: invitation.id,
      email,
      purpose: 'password_reset',
      status: 'pending',
    })

    const result = await setInvitationPasswordForEmail(
      email,
      preview!.id,
      'Synthetic-BUG192-token-mapped-recovery'
    )
    expect(result).not.toHaveProperty('error')
    expect(
      (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
        .rows[0].status
    ).toBe('accepted')
  })

  it('allows at most one credential mutation when sibling reset links race', async () => {
    const makeReset = () =>
      createSilentInvitationForTeams({
        inviteeName: 'Synthetic member',
        email,
        purpose: 'password_reset',
        teamAssignments: [],
        fallbackRole: 'member',
      })
    const first = await makeReset()
    const second = await makeReset()
    const hash = vi.spyOn(bcrypt, 'hash')
    const before = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation

    const outcomes = await Promise.allSettled([
      setInvitationPasswordForEmail(email, first.id, 'Synthetic-BUG192-race-password-a'),
      setInvitationPasswordForEmail(email, second.id, 'Synthetic-BUG192-race-password-b'),
    ])

    expect(
      outcomes.filter(result => result.status === 'fulfilled' && !('error' in result.value))
    ).toHaveLength(1)
    expect(hash).toHaveBeenCalledTimes(1)
    const after = (
      await holder.pool.query('SELECT password_auth_generation FROM users WHERE id = $1', [userId])
    ).rows[0].password_auth_generation
    expect(Number(after)).toBe(Number(before) + 1)
    expect(
      (
        await holder.pool.query('SELECT status FROM invitations WHERE id = ANY($1::uuid[])', [
          [first.id, second.id],
        ])
      ).rows
        .map(row => row.status)
        .sort()
    ).toEqual(['accepted', 'revoked'])
    const redeemedId = (
      await holder.pool.query(
        "SELECT id FROM invitations WHERE id = ANY($1::uuid[]) AND status = 'accepted'",
        [[first.id, second.id]]
      )
    ).rows[0].id
    const siblingId = redeemedId === first.id ? second.id : first.id
    await expect(
      setInvitationPasswordForEmail(email, siblingId, 'Synthetic-BUG192-race-replay')
    ).resolves.toMatchObject({ error: 'not_pending' })
  })
  it('rejects expired, revoked, wrong-purpose and wrong-account recovery credentials', async () => {
    const makeInvitation = (purpose: 'password_reset' | 'member_invitation') =>
      createSilentInvitationForTeams({
        inviteeName: 'Synthetic member',
        email,
        purpose,
        teamAssignments: [],
        fallbackRole: 'member',
      })
    const expired = await makeInvitation('password_reset')
    const revoked = await makeInvitation('password_reset')
    const wrongAccount = await makeInvitation('password_reset')
    const memberInvite = await makeInvitation('member_invitation')
    await holder.pool.query(
      "UPDATE invitations SET expires_at = NOW() - interval '1 second' WHERE id = $1",
      [expired.id]
    )
    await holder.pool.query("UPDATE invitations SET status = 'revoked' WHERE id = $1", [revoked.id])

    await expect(
      setInvitationPasswordForEmail(email, expired.id, 'Synthetic-BUG192-expired-reset')
    ).resolves.toMatchObject({ error: 'expired' })
    await expect(
      setInvitationPasswordForEmail(email, revoked.id, 'Synthetic-BUG192-revoked-reset')
    ).resolves.toMatchObject({ error: 'not_pending' })
    await expect(
      setInvitationPasswordForEmail(
        'other@example.invalid',
        wrongAccount.id,
        'Synthetic-BUG192-wrong-account'
      )
    ).resolves.toMatchObject({ error: 'forbidden' })
    await expect(
      setInvitationPasswordForEmail(email, memberInvite.id, 'Synthetic-BUG192-wrong-purpose')
    ).resolves.toMatchObject({ error: 'not_found' })
    expect(
      (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
        .password_hash
    ).toBe(hash)
  })
  it('fails recovery closed when durable password work authority is unavailable', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    await holder.pool.query(
      'ALTER TABLE password_verification_work RENAME TO password_verification_work_unavailable'
    )
    try {
      await expect(
        setInvitationPasswordForEmail(email, invitation.id, 'Synthetic-BUG192-no-authority')
      ).rejects.toMatchObject({ status: 503 })
      expect(
        (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
          .rows[0].status
      ).toBe('pending')
      expect(
        (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
          .password_hash
      ).toBe(hash)
    } finally {
      await holder.pool.query(
        'ALTER TABLE password_verification_work_unavailable RENAME TO password_verification_work'
      )
    }
  })
  it('bounds recovery hashing with the shared owner and does not hash while it is busy', async () => {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: 'Synthetic member',
      email,
      purpose: 'password_reset',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const lease = await acquirePasswordWork()
    expect(lease).not.toBeNull()
    const hashSpy = vi.spyOn(bcrypt, 'hash')
    try {
      await expect(
        setInvitationPasswordForEmail(email, invitation.id, 'Synthetic-BUG192-owner-busy')
      ).rejects.toMatchObject({ status: 429, reason: 'verification_busy' })
      expect(hashSpy).not.toHaveBeenCalled()
      expect(
        (await holder.pool.query('SELECT status FROM invitations WHERE id = $1', [invitation.id]))
          .rows[0].status
      ).toBe('pending')
      expect(
        (await holder.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0]
          .password_hash
      ).toBe(hash)
    } finally {
      hashSpy.mockRestore()
      await lease?.release()
    }
  })
  it('provisioning and lifecycle changes fence stale completions at the database boundary', async () => {
    for (const update of ['password_hash = NULL', 'lifecycle_version = lifecycle_version + 1']) {
      const stale = await capturePasswordEvaluation(email, false)
      await holder.pool.query(`UPDATE users SET ${update} WHERE id=$1`, [userId])
      expect(await completePasswordEvaluation(stale, false)).toBe(false)
    }
  })
  it('new identity creation fences an old shadow evaluation', async () => {
    const stale = await capturePasswordEvaluation('new@example.invalid', false)
    await holder.pool.query(
      "INSERT INTO users(email,password_hash) VALUES ('new@example.invalid',$1)",
      [hash]
    )
    expect(await completePasswordEvaluation(stale, false)).toBe(false)
  })
  it('two aggregate reservations cannot both win, and denials do not advance pace', async () => {
    const results = await Promise.allSettled([reservePasswordPace(), reservePasswordPace()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const before = (await holder.pool.query('SELECT * FROM password_verification_pace')).rows
    await expect(reservePasswordPace()).rejects.toMatchObject({ status: 429 })
    expect((await holder.pool.query('SELECT * FROM password_verification_pace')).rows).toEqual(
      before
    )
    await holder.pool.query(
      "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 minute'"
    )
    await reservePasswordPace()
    await expect(reservePasswordPace()).rejects.toMatchObject({ status: 429 })
  })
  it('persisted aggregate pacing works across independent Node processes', async () => {
    // The required hosted PostgreSQL lane runs source tests without building Control API.
    // Reuse its declared ts-node resolver so both processes execute the real producer.
    const script = `require('ts-node').register({project:'./tsconfig.json',experimentalResolver:true,transpileOnly:true});const {reservePasswordPace}=require('./src/services/auth/passwordCredentialVerification.ts');reservePasswordPace().then(()=>{console.log('ALLOWED');process.exit(0)},e=>{console.log('DENIED:'+e.status);process.exit(e.status===429?0:1)})`
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
          cwd: process.cwd(),
          env: { ...process.env, CONTROL_API_PG_CONNECTION_STRING: connectionString },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = '',
          err = ''
        child.stdout.on('data', c => (out += c))
        child.stderr.on('data', c => (err += c))
        const timeout = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error('bounded child timed out'))
        }, 10000)
        child.once('exit', code => {
          clearTimeout(timeout)
          if (code !== 0) reject(new Error('child failed: ' + err))
          else resolve(out.trim())
        })
      })
    const results = await Promise.all([run(), run()])
    expect(results.sort()).toEqual(['ALLOWED', 'DENIED:429'])
  })
  it('busy bcrypt is rejected without queue and the reserved pace is not refunded', async () => {
    let started!: () => void, finish!: (value: boolean) => void
    const entered = new Promise<void>(r => (started = r)),
      held = new Promise<boolean>(r => (finish = r))
    const spy = vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async () => {
      started()
      return held
    })
    const first = verifyMemberPassword(email, 'wrong', { publicLogin: false, userId })
    await entered
    try {
      await holder.pool.query(
        "UPDATE password_verification_pace SET next_permit=clock_timestamp()-interval '1 second'"
      )
      await expect(
        verifyMemberPassword('shadow@example.invalid', 'wrong', { publicLogin: true })
      ).rejects.toMatchObject({ status: 429 })
      expect(spy).toHaveBeenCalledTimes(1)
      await expect(reservePasswordPace()).rejects.toMatchObject({ status: 429 })
    } finally {
      finish(false)
      await first
    }
  })
  it('cleanup retains each active component and preserves stale-result fencing after recreation', async () => {
    const t = await now()
    for (const kind of ['attempt', 'failure', 'cooldown']) {
      const identity = `${kind}@example.invalid`
      await capturePasswordEvaluation(identity, false)
      await holder.pool.query(
        'UPDATE password_identifier_state SET attempts=$2,failures=$3,locked_until_ms=$4 WHERE identifier_key=$1',
        [
          passwordIdentifierKey(identity),
          kind === 'attempt' ? [t] : [],
          kind === 'failure' ? [t] : [],
          kind === 'cooldown' ? t + policy.cooldownMs : 0,
        ]
      )
    }
    const old = await capturePasswordEvaluation('expired@example.invalid', false)
    await holder.pool.query(
      'UPDATE password_identifier_state SET retained_until_ms=0 WHERE identifier_key=$1',
      [passwordIdentifierKey('expired@example.invalid')]
    )
    expect(await cleanupPasswordIdentifierState()).toBe(1)
    expect((await holder.pool.query('SELECT * FROM password_identifier_state')).rows).toHaveLength(
      3
    )
    await capturePasswordEvaluation('expired@example.invalid', false)
    expect(await completePasswordEvaluation(old, false)).toBe(false)
    expect(
      (await holder.pool.query('SELECT password_auth_generation FROM users WHERE id=$1', [userId]))
        .rows[0]
    ).toHaveProperty('password_auth_generation')
  })
})
