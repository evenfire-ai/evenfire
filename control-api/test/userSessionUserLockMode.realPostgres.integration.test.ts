import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import type { AuthClaims } from '../src/profileTypes.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { exchangeLegacyExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import { authenticatePasswordAndIssueSession } from '../src/services/auth/passwordSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// Session paths lock the user row FOR NO KEY UPDATE (owner Q-B): an FK
// KEY SHARE holder no longer delays them, while issuance, lifecycle updates and
// deletes still serialize on the row. Login, invitation acceptance and the
// team-session exchange reuse that locked row for issuance (AUTH-5), so a
// retirement that commits while they wait must still win. Every transaction
// that touches a user's row and its team_members rows locks the user row
// first, so acceptance and exchange cannot deadlock.

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const flow = vi.hoisted(() => ({
  validateInvitationFlowToken: vi.fn(),
  storeDesktopAuthorizationToken: vi.fn(),
}))
const accessPolicy = vi.hoisted(() => ({ resolveEffectiveUserAccessPolicy: vi.fn() }))
const login = vi.hoisted(() => ({
  passwordLoginData: vi.fn(async (): Promise<unknown> => {
    throw new Error('passwordLoginData must be primed with a pre-retirement snapshot')
  }),
}))

vi.mock('../src/services/invitationFlowRegistrationService.js', () => flow)
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => accessPolicy)
vi.mock('../src/services/directory/login.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/services/directory/login.js')>()
  return { ...real, passwordLoginData: login.passwordLoginData }
})
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
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe.sequential : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const ISSUANCE_REFUSED = 'legacy user-session issuance requires an active lifecycle generation'
const PASSWORD = 'Synthetic-Lock-Mode-Password-1!'
// Every connection of the suite, including the production paths that open
// their own transactions, gives up on a lock after this bound; each case's
// own timeout leaves room for that bound to fire and for the cleanup.
const LOCK_TIMEOUT_MS = 10_000
const CASE_TIMEOUT_MS = 40_000

// Statements the cases wait on, matched against pg_stat_activity.query.
const SESSION_USER_LOCK = /SELECT id FROM users WHERE id = \$1 FOR NO KEY UPDATE/
// Single-line on purpose: the multi-line password-setup lock never matches it.
const ACCEPTANCE_USER_LOCK =
  /SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version FROM users WHERE id = \$1 FOR NO KEY UPDATE/
const CREDENTIAL_USER_LOCK = /FROM users[\s\S]*password_hash = \$3[\s\S]*FOR NO KEY UPDATE/
const LIFECYCLE_UPDATE = /UPDATE users SET lifecycle_version = lifecycle_version \+ 1/
const USER_DELETE = /DELETE FROM users WHERE id = \$1/

const legacyPolicy = {
  policyVersion: '1',
  policyRevision: 'user-session-user-lock-mode',
  acceptV1: true,
  issueV1: true,
  acceptV2: false,
  issueV2: false,
  renewV2: false,
  switchCompatibility: true,
  minimumClientVersion: null,
  enforceMinimumClient: false,
} as EffectiveUserAccessPolicy

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use(createExternalInvitationsRouter())
  a.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : 'unknown route failure'
      res.status(500).json({ error: 'Internal Server Error', message })
    }
  )
  return a
}

type Settled<T> = { value: T } | { error: unknown }

// Starts an operation whose outcome the case inspects later, and registers it
// so the case's cleanup can wait for it before releasing connections.
function track<T>(pending: Promise<unknown>[], operation: Promise<T>): Promise<Settled<T>> {
  const settled = operation.then(
    value => ({ value }),
    (error: unknown) => ({ error })
  )
  pending.push(settled)
  return settled
}

describeRealPostgres('session user-row lock mode on real PostgreSQL', () => {
  const database = `control_api_user_lock_mode_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const flowTokens = new Map<string, { capability: string; email: string }>()
  let adminPool: Pool
  let databasePool: Pool

  async function backendPid(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    return Number(result.rows[0]!.pid)
  }

  // The given backend waits on the blocker while running the expected statement.
  async function waitForBlock(
    blockedPid: number,
    blockerPid: number,
    expected: RegExp
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await databasePool.query<{ blocked: boolean; query: string | null }>(
        `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked,
                (SELECT query FROM pg_stat_activity WHERE pid = $1::int) AS query`,
        [blockedPid, blockerPid]
      )
      const row = result.rows[0]
      if (row?.blocked && expected.test(row.query ?? '')) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`expected backend ${blockedPid} to wait on ${blockerPid} in ${expected}`)
  }

  // For production paths that open their own transaction: the backend of this
  // database that runs the expected statement while it waits on a lock. When a
  // blocker is given, the wait must be on that backend.
  async function waitForWaitingStatement(expected: RegExp, blockerPid?: number): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await databasePool.query<{ pid: number; query: string; blockers: number[] }>(
        `SELECT activity.pid, activity.query, pg_blocking_pids(activity.pid) AS blockers
           FROM pg_stat_activity activity
          WHERE activity.datname = current_database()
            AND activity.pid <> pg_backend_pid()
            AND cardinality(pg_blocking_pids(activity.pid)) > 0`
      )
      const match = result.rows.find(
        row =>
          expected.test(row.query) &&
          (blockerPid === undefined || row.blockers.map(Number).includes(blockerPid))
      )
      if (match) return Number(match.pid)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`expected a backend running ${expected} to wait on a lock`)
  }

  async function seedUser(label: string): Promise<{ userId: string; email: string }> {
    const userId = randomUUID()
    const email = `${label}-${userId}@example.test`
    const passwordHash = await bcrypt.hash(PASSWORD, 4)
    await databasePool.query(
      `INSERT INTO users(id, email, name, password_hash) VALUES ($1, $2, $3, $4)`,
      [userId, email, label, passwordHash]
    )
    return { userId, email }
  }

  async function seedTeamMember(userId: string, label: string): Promise<string> {
    const teamId = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )
    return teamId
  }

  async function seedInvitation(
    email: string,
    teamId: string,
    role: 'admin' | 'member'
  ): Promise<{ invitationId: string; flowToken: string }> {
    const capability = `db-token-${randomUUID()}`
    const invitation = await databasePool.query<{ id: string }>(
      `INSERT INTO invitations(email, role, token, status, purpose, expires_at)
       VALUES ($1, $2, $3, 'pending', 'member_invitation', NOW() + INTERVAL '1 hour')
       RETURNING id::text AS id`,
      [email, role, capability]
    )
    const invitationId = invitation.rows[0]!.id
    await databasePool.query(
      `INSERT INTO invitation_teams(invitation_id, team_id, role) VALUES ($1, $2, $3)`,
      [invitationId, teamId, role]
    )
    const flowToken = `flow-${randomUUID()}`
    flowTokens.set(flowToken, { capability, email })
    return { invitationId, flowToken }
  }

  // An invitation already accepted by the user, with the user's profile row,
  // so a replay's profile insert takes no FK lock on the user.
  async function seedAcceptedInvitation(
    user: { userId: string; email: string },
    label: string
  ): Promise<{ invitationId: string; flowToken: string }> {
    const teamId = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
    await databasePool.query(`INSERT INTO profiles(user_id, display_name) VALUES ($1, $2)`, [
      user.userId,
      label,
    ])
    const seeded = await seedInvitation(user.email, teamId, 'member')
    await databasePool.query(
      `UPDATE invitations
          SET status = 'accepted', accepted_at = NOW(), accepted_user_id = $2
        WHERE id = $1`,
      [seeded.invitationId, user.userId]
    )
    return seeded
  }

  function legacyToken(user: { userId: string; email: string }, teamId: string) {
    const token = signExternalSessionToken({
      userId: user.userId,
      email: user.email,
      teamId,
      role: 'admin',
      authGeneration: 1,
    })
    const claims: AuthClaims | null = verifyExternalSessionToken(token)
    if (!claims) throw new Error('test producer failed to verify its V1 token')
    return { token, claims }
  }

  function accept(flowToken: string, email: string) {
    return request(app())
      .post('/external/invitations/accept')
      .send({ email, token: flowToken, sessionContract: 'v1' })
      .then(response => response)
  }

  // A governed retirement (the users_lifecycle_state_check needs the actor,
  // reason and operation columns), left uncommitted on the gate connection.
  async function beginRetirement(gate: PoolClient, userId: string): Promise<void> {
    await gate.query('BEGIN')
    const operation = await gate.query<{ id: string }>(
      `INSERT INTO desktop_user_retirement_operations(
         actor_type, actor_desktop_user_id, target_user_id,
         idempotency_key_hash, request_fingerprint, reason
       )
       VALUES ('platform_user', $1::uuid, $1::uuid, repeat('a', 64), repeat('b', 64),
               'session lock mode retirement')
       RETURNING id::text AS id`,
      [userId]
    )
    const retired = await gate.query(
      `UPDATE users
          SET lifecycle_state = 'retired',
              retired_at = NOW(),
              retirement_reason = 'session lock mode retirement',
              retired_by_type = 'platform_user',
              retired_by_desktop_user_id = $1::uuid,
              retirement_operation_id = $2::uuid,
              lifecycle_version = lifecycle_version + 1
        WHERE id = $1::uuid`,
      [userId, operation.rows[0]!.id]
    )
    expect(retired.rowCount).toBe(1)
  }

  async function lifecycle(userId: string): Promise<{ state: string; version: number }> {
    const result = await databasePool.query<{ state: string; version: string }>(
      `SELECT lifecycle_state AS state, lifecycle_version::text AS version
         FROM users
        WHERE id = $1`,
      [userId]
    )
    const row = result.rows[0]
    if (!row) throw new Error(`user ${userId} is missing`)
    return { state: row.state, version: Number(row.version) }
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await databasePool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM external_user_sessions WHERE user_id = $1`,
      [userId]
    )
    return result.rows[0]!.count
  }

  function issueOn(client: PoolClient, user: { userId: string; email: string }) {
    return createUserSession(
      { userId: user.userId, email: user.email, authenticationMethods: ['pwd'] },
      { db: client }
    )
  }

  // Ends every open transaction, then waits for every tracked operation, so no
  // query is still pending when its connection is released or the pool closes.
  async function settle(clients: PoolClient[], pending: Promise<unknown>[]): Promise<void> {
    for (const client of clients) await client.query('ROLLBACK').catch(() => undefined)
    await Promise.allSettled(pending)
    for (const client of clients) client.release()
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString, options: `-c lock_timeout=${LOCK_TIMEOUT_MS}` })
    holder.pool = databasePool
    await initDb({ connect: () => databasePool.connect() })
    accessPolicy.resolveEffectiveUserAccessPolicy.mockResolvedValue(legacyPolicy)
    flow.validateInvitationFlowToken.mockImplementation(async (token: string) => {
      const fixture = flowTokens.get(token)
      if (!fixture) throw new Error(`invalid invitation flow token ${token}`)
      return { email: fixture.email, invitationUuid: fixture.capability }
    })
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it(
    '(a) issues a session while an FK child insert holds KEY SHARE on the user',
    async () => {
      const user = await seedUser('fk-holder')
      const holderClient = await databasePool.connect()
      const issuer = await databasePool.connect()
      try {
        await holderClient.query('BEGIN')
        await holderClient.query(
          `INSERT INTO workflow_runs_audit(
             run_id, run_namespace, run_name, recipe_namespace, recipe_name,
             triggerer_user_id, triggerer_actor_type, trigger_source, idempotency_key,
             triggered_at, completed_at, final_phase, step_count, snapshot_sha
           )
           VALUES (gen_random_uuid(), 'lock-mode', 'fk-holder', 'lock-mode', 'fk-holder',
                   $1, 'user', 'onDemand', 'lock-mode-fk-holder',
                   NOW(), NOW(), 'Succeeded', 0, 'lock-mode')`,
          [user.userId]
        )
        const holderPid = await backendPid(holderClient)

        await issuer.query('BEGIN')
        await issuer.query(`SET LOCAL lock_timeout = '2s'`)
        const issued = await issueOn(issuer, user)
        expect(issued.identity.userId).toBe(user.userId)

        // Witness: the FK holder was still open while issuance returned.
        const holderState = await databasePool.query<{ state: string }>(
          `SELECT state FROM pg_stat_activity WHERE pid = $1`,
          [holderPid]
        )
        expect(holderState.rows).toEqual([{ state: 'idle in transaction' }])
        await issuer.query('COMMIT')
        expect(await sessionCount(user.userId)).toBe(1)
      } finally {
        await settle([issuer, holderClient], [])
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    '(b) serializes a lifecycle update behind an open issuance',
    async () => {
      const user = await seedUser('lifecycle-update')
      const issuer = await databasePool.connect()
      const updater = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await issuer.query('BEGIN')
        await issueOn(issuer, user)
        const issuerPid = await backendPid(issuer)

        await updater.query('BEGIN')
        const updaterPid = await backendPid(updater)
        const update = track(
          pending,
          updater.query(
            `UPDATE users SET lifecycle_version = lifecycle_version + 1 WHERE id = $1`,
            [user.userId]
          )
        )
        await waitForBlock(updaterPid, issuerPid, LIFECYCLE_UPDATE)
        await issuer.query('COMMIT')

        expect(await update).toEqual({ value: expect.objectContaining({ rowCount: 1 }) })
        await updater.query('COMMIT')
        expect(await lifecycle(user.userId)).toEqual({ state: 'active', version: 2 })
        expect(await sessionCount(user.userId)).toBe(1)
      } finally {
        await settle([issuer, updater], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    '(b) serializes a user delete behind an open issuance',
    async () => {
      const user = await seedUser('user-delete')
      const issuer = await databasePool.connect()
      const deleter = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await issuer.query('BEGIN')
        await issueOn(issuer, user)
        const issuerPid = await backendPid(issuer)

        await deleter.query('BEGIN')
        const deleterPid = await backendPid(deleter)
        const deletion = track(
          pending,
          deleter.query(`DELETE FROM users WHERE id = $1`, [user.userId])
        )
        await waitForBlock(deleterPid, issuerPid, USER_DELETE)
        await issuer.query('COMMIT')

        expect(await deletion).toEqual({ value: expect.objectContaining({ rowCount: 1 }) })
        await deleter.query('ROLLBACK')
        expect(await sessionCount(user.userId)).toBe(1)
      } finally {
        await settle([issuer, deleter], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    '(c) serializes two issuances for the same user',
    async () => {
      const user = await seedUser('self-serialize')
      const first = await databasePool.connect()
      const second = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await first.query('BEGIN')
        await issueOn(first, user)
        const firstPid = await backendPid(first)

        await second.query('BEGIN')
        const secondPid = await backendPid(second)
        // No caller-held lock: createUserSession takes the user lock itself.
        const secondIssue = track(pending, issueOn(second, user))
        await waitForBlock(secondPid, firstPid, SESSION_USER_LOCK)
        await first.query('COMMIT')

        expect(await secondIssue).toEqual({
          value: expect.objectContaining({
            identity: expect.objectContaining({ userId: user.userId }),
          }),
        })
        await second.query('COMMIT')
        expect(await sessionCount(user.userId)).toBe(2)
      } finally {
        await settle([first, second], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    'runs an invitation acceptance and a team-session exchange of one user without deadlock',
    async () => {
      // The user already belongs to the team the invitation targets, so the
      // acceptance writes the same team_members row the exchange locks.
      const user = await seedUser('accept-exchange')
      const teamId = await seedTeamMember(user.userId, 'accept-exchange')
      const { flowToken, invitationId } = await seedInvitation(user.email, teamId, 'admin')
      const { token, claims } = legacyToken(user, teamId)

      const gate = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await gate.query('BEGIN')
        await gate.query(`SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, [user.userId])
        const gatePid = await backendPid(gate)

        // The exchange queues first on the user row, so it takes the row first
        // once the gate ends.
        const exchange = track(
          pending,
          exchangeLegacyExternalUserSession(
            { token, claims, userId: user.userId, email: user.email, teamId, role: 'admin' },
            { policy: legacyPolicy }
          )
        )
        await waitForWaitingStatement(SESSION_USER_LOCK, gatePid)
        // Witness: the acceptance reached its user lock. With the old order it
        // would hold the team_members row here, before waiting on the user.
        const acceptance = track(pending, accept(flowToken, user.email))
        await waitForWaitingStatement(ACCEPTANCE_USER_LOCK)
        await gate.query('COMMIT')

        const exchanged = await exchange
        const accepted = await acceptance
        expect(exchanged).toEqual({
          value: { status: 'issued', token: expect.any(String), role: 'admin' },
        })
        if (!('value' in accepted)) throw accepted.error
        expect(accepted.value.status, JSON.stringify(accepted.value.body)).toBe(200)
        expect(accepted.value.body).toMatchObject({
          accepted: true,
          userId: user.userId,
          sessionContract: 'v1',
          token: expect.any(String),
        })
        const state = await databasePool.query<{ status: string }>(
          `SELECT status FROM invitations WHERE id = $1`,
          [invitationId]
        )
        expect(state.rows).toEqual([{ status: 'accepted' }])
      } finally {
        await settle([gate], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    'retirement wins over a password login waiting on the credential lock',
    async () => {
      const user = await seedUser('login-retired')
      const teamId = await seedTeamMember(user.userId, 'login-retired')
      const stored = await databasePool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [user.userId]
      )
      // The snapshot passwordLoginData returned before the retirement, so the
      // decision is taken by the issuance lock and not by the verifier.
      login.passwordLoginData.mockResolvedValueOnce({
        user: { id: user.userId, email: user.email, name: 'login-retired', picture: null },
        membership: { team_id: teamId, role: 'admin', team_name: 'login-retired' },
        credentialHash: stored.rows[0]!.password_hash,
        authGeneration: 1,
      })
      expect(await lifecycle(user.userId)).toEqual({ state: 'active', version: 1 })

      const gate = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await beginRetirement(gate, user.userId)
        const gatePid = await backendPid(gate)
        const outcome = track(
          pending,
          authenticatePasswordAndIssueSession({
            email: user.email,
            password: PASSWORD,
            contract: 'v1',
            policy: legacyPolicy,
          })
        )
        await waitForWaitingStatement(CREDENTIAL_USER_LOCK, gatePid)
        await gate.query('COMMIT')

        expect(await outcome).toEqual({
          error: expect.objectContaining({ message: ISSUANCE_REFUSED }),
        })
        expect(login.passwordLoginData).toHaveBeenCalledTimes(1)
        expect(await lifecycle(user.userId)).toEqual({ state: 'retired', version: 2 })
      } finally {
        await settle([gate], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    'retirement wins over an invitation acceptance waiting on the user lock',
    async () => {
      const user = await seedUser('invitation-retired')
      const teamId = randomUUID()
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'invitation-retired')`, [
        teamId,
      ])
      const { flowToken, invitationId } = await seedInvitation(user.email, teamId, 'member')

      const gate = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await beginRetirement(gate, user.userId)
        const gatePid = await backendPid(gate)
        const acceptance = track(pending, accept(flowToken, user.email))
        await waitForWaitingStatement(ACCEPTANCE_USER_LOCK, gatePid)
        await gate.query('COMMIT')

        const settled = await acceptance
        if (!('value' in settled)) throw settled.error
        // The decision is taken on the locked user row, before any invitation
        // or membership write: the route's user_retired answer.
        expect(settled.value.status).toBe(401)
        expect(settled.value.body).toEqual({ error: 'Unauthorized' })
        expect(settled.value.body).not.toHaveProperty('token')
        const state = await databasePool.query<{
          status: string
          accepted_user_id: string | null
        }>(`SELECT status, accepted_user_id FROM invitations WHERE id = $1`, [invitationId])
        expect(state.rows).toEqual([{ status: 'pending', accepted_user_id: null }])
        const membership = await databasePool.query(
          `SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2`,
          [user.userId, teamId]
        )
        expect(membership.rowCount).toBe(0)
        expect(await lifecycle(user.userId)).toEqual({ state: 'retired', version: 2 })
      } finally {
        await settle([gate], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  // Users before invitations: a replay waits on the user row without holding
  // the accepted invitation that a user delete (ON DELETE SET NULL) or a
  // Google login (accepted_user_id backfill) writes after locking the user.
  it(
    'a replayed acceptance and a user delete do not deadlock',
    async () => {
      const user = await seedUser('replay-delete')
      const { flowToken, invitationId } = await seedAcceptedInvitation(user, 'replay-delete')

      const gate = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await gate.query('BEGIN')
        await gate.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [user.userId])
        const gatePid = await backendPid(gate)
        const acceptance = track(pending, accept(flowToken, user.email))
        await waitForWaitingStatement(ACCEPTANCE_USER_LOCK, gatePid)
        const deleted = await gate.query(`DELETE FROM users WHERE id = $1`, [user.userId])
        expect(deleted.rowCount).toBe(1)
        await gate.query('COMMIT')

        const settled = await acceptance
        if (!('value' in settled)) throw settled.error
        expect(settled.value.status, JSON.stringify(settled.value.body)).toBe(404)
        expect(settled.value.body).toEqual({ error: 'not_found' })
        const state = await databasePool.query<{ accepted_user_id: string | null }>(
          `SELECT accepted_user_id FROM invitations WHERE id = $1`,
          [invitationId]
        )
        expect(state.rows).toEqual([{ accepted_user_id: null }])
      } finally {
        await settle([gate], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    'a replayed acceptance and a Google login do not deadlock',
    async () => {
      const user = await seedUser('replay-login')
      const { flowToken, invitationId } = await seedAcceptedInvitation(user, 'replay-login')

      const gate = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await gate.query('BEGIN')
        // The literal statements of googleLoginData (login.ts) and of
        // linkAcceptedInvitationsToUser, in their order.
        await gate.query(
          `UPDATE users
              SET name = COALESCE($2, name),
                  picture = COALESCE($3, picture),
                  updated_at = NOW()
            WHERE email = $1
          RETURNING id, email, name, picture, lifecycle_version`,
          [user.email, 'replay-login', null]
        )
        const gatePid = await backendPid(gate)
        const acceptance = track(pending, accept(flowToken, user.email))
        await waitForWaitingStatement(ACCEPTANCE_USER_LOCK, gatePid)
        await gate.query(
          `UPDATE invitations
              SET accepted_user_id = COALESCE(accepted_user_id, $2)
            WHERE LOWER(email) = LOWER($1)
              AND status = 'accepted'`,
          [user.email, user.userId]
        )
        await gate.query('COMMIT')

        const settled = await acceptance
        if (!('value' in settled)) throw settled.error
        expect(settled.value.status, JSON.stringify(settled.value.body)).toBe(200)
        expect(settled.value.body).toMatchObject({
          accepted: true,
          userId: user.userId,
          replay: true,
        })
        expect(settled.value.body).not.toHaveProperty('token')
        const state = await databasePool.query<{ accepted_user_id: string | null }>(
          `SELECT accepted_user_id FROM invitations WHERE id = $1`,
          [invitationId]
        )
        expect(state.rows).toEqual([{ accepted_user_id: user.userId }])
      } finally {
        await settle([gate], pending)
      }
    },
    CASE_TIMEOUT_MS
  )

  // validateLegacyUserSession({ lockUser: true }) already re-checks the
  // lifecycle under this same lock, so this case is a regression guard: a
  // mutation of the exchange's AUTH-5 issuance is caught by the statement
  // sequence pinned in app.test.ts (plan Addendum V2-M11).
  it(
    'retirement wins over a team-session exchange waiting on the user lock',
    async () => {
      const user = await seedUser('exchange-retired')
      const teamId = await seedTeamMember(user.userId, 'exchange-retired')
      const { token, claims } = legacyToken(user, teamId)

      const gate = await databasePool.connect()
      const pending: Promise<unknown>[] = []
      try {
        await beginRetirement(gate, user.userId)
        const gatePid = await backendPid(gate)
        const exchange = track(
          pending,
          exchangeLegacyExternalUserSession(
            { token, claims, userId: user.userId, email: user.email, teamId, role: 'admin' },
            { policy: legacyPolicy }
          )
        )
        await waitForWaitingStatement(SESSION_USER_LOCK, gatePid)
        await gate.query('COMMIT')

        expect(await exchange).toEqual({ value: { status: 'invalid_session' } })
        expect(await lifecycle(user.userId)).toEqual({ state: 'retired', version: 2 })
      } finally {
        await settle([gate], pending)
      }
    },
    CASE_TIMEOUT_MS
  )
})
