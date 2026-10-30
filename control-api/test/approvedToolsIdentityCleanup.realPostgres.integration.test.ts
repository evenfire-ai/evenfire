import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import {
  cleanupFixtureIdentities,
  createFixtureIdentities,
  createFixtureIdentityJournal,
} from '../../tests/e2e/fixtures/codex-subscription/approved-tools-setup/identity-lifecycle.mjs'
import { initDb, withTransaction } from '../src/db.js'
import { passwordIdentifierKey } from '../src/services/auth/passwordAdmissionState.js'
import { verifyUserPassword } from '../src/services/directory/login.js'
import { retireDesktopUserInTransaction } from '../src/services/directory/users.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// The fixture identity cleanup is the only producer that deletes fixture users.
// These suites pin the real schema interaction: product queries run as
// `control_api_runtime` (the role whose sessions the password-admission fence
// guards), the cleanup transaction is a real BEGIN/COMMIT on that pool, and the
// governed retirement is the product service itself.
const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
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
const realPg = adminUrl ? describe : describe.skip
const run = `approved-tools-${randomBytes(6).toString('hex')}`
const profile = 'owned-e2e'
const adminUsername = `fixture-admin-${randomBytes(4).toString('hex')}`
const env = {
  NODE_ENV: 'test',
  EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '1',
  APPROVED_TOOLS_RUN_ID: run,
  MINIKUBE_PROFILE: profile,
  CONTROL_API_REAL_PG_CONTEXT: profile,
}

function fixtureInput() {
  return {
    mode: 'deterministic',
    suite: 'model-step-retry',
    run,
    profile,
    context: profile,
    adminUsername,
    userEmail: `${run}@example.test`,
    unauthorizedEmail: `${run}-unauthorized@example.test`,
    userPassword: 'Synthetic-fixture-member-password',
    unauthorizedPassword: 'Synthetic-fixture-negative-password',
    scenarios: [
      {
        runId: `${run}-83`,
        agentName: `${run}-agent-83`,
        contextName: `${run}-context-83`,
      },
    ],
  }
}

realPg('approved-tools identity cleanup on real PostgreSQL', () => {
  const database = `approved_tools_cleanup_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let owner: Pool
  let runtimePool: Pool

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    owner = new Pool({ connectionString: url.toString() })
    await initDb(owner)
    runtimePool = new Pool({
      connectionString: url.toString(),
      options: '-c role=control_api_runtime',
    })
    // Liveness for every product query in this file: the transaction body and
    // the admission path run as the role the fence targets.
    expect((await runtimePool.query('SELECT current_user')).rows[0].current_user).toBe(
      'control_api_runtime'
    )
    holder.pool = runtimePool
  }, 60_000)

  afterAll(async () => {
    try {
      holder.pool = null as unknown as Pool
      await endPoolAndWaitForClients(runtimePool)
      await endPoolAndWaitForClients(owner)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin?.end()
    }
  })

  it('retires the fixture users through the governed path and retains the audit', async () => {
    // The fence admits the identifier-state detach only in phase `v2`; `legacy`
    // would let a raw delete pass and hide the defect.
    const phase = (
      await owner.query('SELECT phase FROM password_admission_rollout_state WHERE singleton')
    ).rows[0].phase
    expect(phase).toBe('v2')

    const input = fixtureInput()
    const journal = createFixtureIdentityJournal(input, { env })
    const witnesses = {
      permissionEvents: 0,
      journalSaves: 0,
      publications: 0,
      revocations: 0,
      rebuilds: 0,
    }
    const adapters = {
      env,
      withTransaction,
      hashPassword: (value: string, rounds: number) => bcrypt.hash(value, rounds),
      appendPermissionEvents: async () => {
        witnesses.permissionEvents++
      },
      saveJournal: async () => {
        witnesses.journalSaves++
      },
      revokeCodexSubscriptionConnection: async () => {
        witnesses.revocations++
      },
      rebuildLiveCodexUnionAllowlist: async () => {
        witnesses.rebuilds++
      },
      publishRuntimeAllowlist: async () => {
        witnesses.publications++
      },
      // The product's own governed retirement, not a stub.
      retireDesktopUserInTransaction,
    }

    await createFixtureIdentities(input, { ...adapters, initialJournal: journal })
    const [member, negative] = journal.users

    // A failed login through the product admission path creates the identifier
    // state the raw delete could never remove under phase `v2`.
    await owner.query(
      "UPDATE password_verification_pace SET next_permit = clock_timestamp() - interval '1 second'"
    )
    const authenticated = await verifyUserPassword({
      userId: member.id,
      email: member.email,
      password: 'Synthetic-wrong-password',
    })
    expect(authenticated).toBe(false)
    const identifierKey = passwordIdentifierKey(member.email)
    const before = await owner.query(
      'SELECT user_id::text, cardinality(failures)::int AS failures FROM password_identifier_state WHERE identifier_key = $1',
      [identifierKey]
    )
    expect(before.rows).toHaveLength(1)
    expect(before.rows[0].user_id).toBe(member.id)
    expect(before.rows[0].failures).toBeGreaterThanOrEqual(1)

    // The lane's Control Admin is the recorded retirement actor.
    const adminId = (
      await owner.query(
        `INSERT INTO control_admin_users(username, password_hash, email, role, status)
         VALUES ($1, $2, NULL, 'admin', 'active') RETURNING id::text AS id`,
        [adminUsername, await bcrypt.hash('Synthetic-admin-password', 12)]
      )
    ).rows[0].id as string

    // Green after: the user rows are gone, the identifier row and the
    // retirement operation remain as retained audit.
    const result = await cleanupFixtureIdentities(input, journal, adapters)
    expect(result).toEqual({ outcome: 'deleted-with-audit-retained', auditRetention: 'preserved' })
    expect(journal.status).toBe('cleaned')
    expect(journal.cleanupOutcome).toBe('deleted-with-audit-retained')

    const users = await owner.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
      [member.id, negative.id],
    ])
    expect(users.rowCount).toBe(0)
    const team = await owner.query('SELECT id FROM teams WHERE id = $1::uuid', [journal.team.id])
    expect(team.rowCount).toBe(0)

    const retained = await owner.query(
      'SELECT user_id::text, cardinality(failures)::int AS failures FROM password_identifier_state WHERE identifier_key = $1',
      [identifierKey]
    )
    expect(retained.rows).toHaveLength(1)
    expect(retained.rows[0].user_id).toBeNull()
    expect(retained.rows[0].failures).toBe(before.rows[0].failures)

    const operations = await owner.query(
      `SELECT operation, actor_type, actor_control_admin_id::text AS actor_id,
              target_user_id::text AS target_id, status, outcome, reason
         FROM desktop_user_retirement_operations WHERE target_user_id = $1::uuid`,
      [member.id]
    )
    expect(operations.rows).toHaveLength(1)
    expect(operations.rows[0]).toEqual({
      operation: 'retire_desktop_user',
      actor_type: 'control_admin',
      actor_id: adminId,
      target_id: member.id,
      status: 'completed',
      outcome: 'deleted',
      reason: 'Approved tools E2E fixture identity cleanup',
    })
    // Liveness of the surrounding cleanup: the create and revoke audit events,
    // the durable journal and the runtime publication all ran, and no
    // connection adapter was needed.
    expect(witnesses.permissionEvents).toBe(2)
    expect(witnesses.journalSaves).toBe(4)
    expect(witnesses.publications).toBe(1)
    expect(witnesses.revocations).toBe(0)
    expect(witnesses.rebuilds).toBe(0)
  }, 60_000)
})
