// Real service transactions, triggers and deterministic PostgreSQL contention witnesses.
// Fixed cases observe production SQL unchanged. Only the seven historical
// characterizations suppress prelock calls to reproduce the original cycles.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { initDb, pool } from '../src/db.js'
import { createAdminUsersRouter } from '../src/routes/admin/users.js'
import { applyComposableCatalogRevisionSchema } from '../src/services/access/userAccessFoundationSchema.js'
import { completeControlAdminInvitation } from '../src/services/adminAuthService.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import { deleteManagedUserForUser, updateMemberRole } from '../src/services/directory/membership.js'
import { adminDeleteUserInTransaction, retireDesktopUser } from '../src/services/directory/users.js'
import { preferVerifiedMediumAccount } from '../src/services/workflowApprovalMediumPreferenceService.js'
import { createRun } from '../src/services/workflowRunService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const evidence = process.env.PR334_DB1_TRACE_EVIDENCE
const describeRealPostgres = adminUrl ? describe : describe.skip
const target = new URL(adminUrl ?? 'postgresql://localhost/postgres')
const events: any[] = []
const barrierClass = 334_031
const database = `pr334_db1_${randomBytes(6).toString('hex')}`
const actorId = randomUUID()
let adminPool: Pool
let databasePool: Pool

function save(name: string, data: unknown) {
  if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(data, null, 2) + '\n')
}
function event(data: unknown) {
  events.push(data)
  if (evidence) appendFileSync(join(evidence, 'trace-events.jsonl'), JSON.stringify(data) + '\n')
}
type Outcome =
  | { status: 'fulfilled'; value: unknown; transaction: string }
  | {
      status: 'rejected'
      code: string
      errorName?: string
      message: string
      detail?: string
      where?: string
      transaction: string
    }
function observe(client: PoolClient, write: Promise<unknown>): Promise<Outcome> {
  return write.then(
    async value => {
      const result = await client.query('COMMIT')
      return { status: 'fulfilled', value, transaction: result.command } as const
    },
    async error => {
      await client.query('ROLLBACK')
      return {
        status: 'rejected',
        code: String(error.code),
        message: error.message,
        errorName: error.name,
        detail: error.detail,
        where: error.where,
        transaction: 'ROLLBACK',
      } as const
    }
  )
}
async function pid(client: PoolClient) {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
}
async function begin(client: PoolClient, application: string) {
  await client.query('BEGIN')
  await client.query("SELECT set_config('application_name', $1, true)", [application])
  // Long enough to capture BOTH edges before PostgreSQL chooses a victim.
  await client.query("SET LOCAL deadlock_timeout = '2s'")
  await client.query("SET LOCAL statement_timeout = '12s'")
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '25s'")
}
async function waitForEdges(edges: [number, number][]) {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const { rows } = await databasePool.query<{ pid: number; blockers: number[] }>(
      'SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ANY($1::int[])',
      [edges.map(([blocked]) => blocked)]
    )
    if (
      edges.every(([blocked, blocker]) =>
        rows.some(row => row.pid === blocked && row.blockers.includes(blocker))
      )
    )
      return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Expected pg_blocking_pids edges not seen: ${JSON.stringify(edges)}`)
}
type Fixture = { user: string; team: string; secondTeam: string; label: string }
async function snapshot(label: string, phase: string, pids: number[], fixture: Fixture) {
  const activity = (
    await databasePool.query(
      `
    SELECT pid, application_name, state, backend_xid::text, wait_event_type, wait_event,
           query, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE pid = ANY($1::int[]) ORDER BY pid`,
      [pids]
    )
  ).rows
  const locks = (
    await databasePool.query(
      `
    SELECT l.pid, a.application_name, l.locktype, l.mode, l.granted,
           l.relation::regclass::text AS relation, l.page, l.tuple,
           l.virtualxid, l.transactionid::text, l.classid::text, l.objid::text,
           l.objsubid, l.fastpath, l.waitstart
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.pid = ANY($1::int[])
     ORDER BY l.pid, l.locktype, relation, l.transactionid::text, l.granted`,
      [pids]
    )
  ).rows
  const xidEdges = (
    await databasePool.query(
      `
    SELECT w.pid AS waiter, w.mode AS wait_mode, w.transactionid::text AS xid,
           h.pid AS holder, h.mode AS held_mode
      FROM pg_locks w JOIN pg_locks h
        ON w.locktype = 'transactionid' AND h.locktype = 'transactionid'
       AND w.transactionid = h.transactionid AND w.pid <> h.pid
     WHERE NOT w.granted AND h.granted AND h.mode = 'ExclusiveLock'
       AND w.pid = ANY($1::int[]) ORDER BY w.pid`,
      [pids]
    )
  ).rows
  // pg_locks does NOT enumerate normally held tuple locks. Keep its raw data
  // intact and supplement with PostgreSQL's pgrowlocks to identify held rows.
  const rowLocks: Record<string, unknown> = {}
  for (const table of [
    'users',
    'team_members',
    'authorization_user_revisions',
    'authorization_team_revisions',
    'workflow_approval_medium_accounts',
  ]) {
    rowLocks[table] = (await databasePool.query(`SELECT * FROM pgrowlocks('${table}')`)).rows
  }
  const visibleRows = (
    await databasePool.query(
      `
    SELECT 'users' AS table_name, id::text AS subject, ctid::text, xmin::text, xmax::text
      FROM users WHERE id = $1::uuid
    UNION ALL SELECT 'authorization_user_revisions', user_id::text, ctid::text, xmin::text, xmax::text
      FROM authorization_user_revisions WHERE user_id = $1::uuid
    UNION ALL SELECT 'authorization_team_revisions', team_id::text, ctid::text, xmin::text, xmax::text
      FROM authorization_team_revisions WHERE team_id = $2::uuid
    UNION ALL SELECT 'team_members', user_id::text, ctid::text, xmin::text, xmax::text
      FROM team_members WHERE user_id = $1::uuid`,
      [fixture.user, fixture.team]
    )
  ).rows
  const data = {
    label,
    phase,
    utc: new Date().toISOString(),
    fixture,
    activity,
    locks,
    xidEdges,
    rowLocks,
    visibleRows,
  }
  save(`${label}.${phase}`, data)
  event({ label, phase, activity, xidEdges })
  return data
}
async function fixture(label: string, legacy = false, medium = true): Promise<Fixture> {
  const user = randomUUID(),
    team = randomUUID(),
    secondTeam = randomUUID()
  await databasePool.query("INSERT INTO users(id, email, name) VALUES ($1, $2, 'DB1 trace')", [
    user,
    `db1-${user}@example.test`,
  ])
  for (const id of [team, secondTeam])
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'DB1 trace')", [id])
  await databasePool.query(
    "INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')",
    [team, user]
  )
  if (medium)
    await databasePool.query(
      `INSERT INTO workflow_approval_medium_accounts
    (user_id, medium, provider_user_id, communication_channel_ref, verified_at)
    VALUES ($1, 'telegram', $2, 'db1-test-channel', NOW())`,
      [user, `db1-${user}`]
    )
  if (legacy) {
    // Simulate pre-0134 subjects after all fixture inserts; keep every real
    // trigger/FK enabled. No production bump implementation is replaced.
    await databasePool.query('DELETE FROM authorization_user_revisions WHERE user_id = $1', [user])
    await databasePool.query('DELETE FROM authorization_team_revisions WHERE team_id = $1', [team])
  }
  return { user, team, secondTeam, label }
}
async function revisionBarrier(application: string, table: string, subject: string) {
  await databasePool.query('INSERT INTO db1_trace_barriers VALUES ($1, $2, $3)', [
    application,
    table,
    subject,
  ])
}
function runWrite(client: PoolClient, f: Fixture) {
  return createRun(
    {
      recipe_namespace: 'db1-trace',
      recipe_name: f.label,
      actor_type: 'user',
      actor_id: f.user,
      team_id: f.team,
      usage_team_id: f.team,
      idempotency_key: null,
      trigger_source: 'onDemand',
      ttl_seconds_after_finished: 2592000,
    },
    client
  )
}
function retirementWrite(
  client: PoolClient,
  f: Fixture,
  options: { authorize?: (db: PoolClient) => Promise<void>; tombstone?: boolean } = {}
) {
  return retireDesktopUser(
    { kind: 'control_admin', controlAdminId: actorId },
    f.user,
    'DB1 local diagnostic',
    `db1-${f.label}-${f.user}`,
    null,
    {
      db: client,
      retainWithoutLinkHistory: options.tombstone,
      authorize: options.authorize ? db => options.authorize!(db as PoolClient) : undefined,
    }
  )
}
async function finalState(f: Fixture) {
  return {
    users: (
      await databasePool.query('SELECT id, lifecycle_state FROM users WHERE id = $1', [f.user])
    ).rows,
    memberships: (
      await databasePool.query('SELECT team_id, status FROM team_members WHERE user_id = $1', [
        f.user,
      ])
    ).rows,
    medium: (
      await databasePool.query(
        'SELECT disabled_at IS NOT NULL AS disabled FROM workflow_approval_medium_accounts WHERE user_id = $1',
        [f.user]
      )
    ).rows,
    runs: (
      await databasePool.query(
        'SELECT run_id, actor_id, phase FROM workflow_runs WHERE recipe_namespace = $1 AND recipe_name = $2',
        ['db1-trace', f.label]
      )
    ).rows,
    operations: (
      await databasePool.query(
        'SELECT status, outcome FROM desktop_user_retirement_operations WHERE target_user_id = $1',
        [f.user]
      )
    ).rows,
  }
}

// Mutation mode only selects a deterministic failure schedule. Mutations of
// the fix itself are made to the production source, never injected by this suite.
const mutation = process.env.PR334_DB1_MUTATION ?? ''
async function backfillRevisions() {
  const c = await databasePool.connect()
  try {
    await c.query('BEGIN')
    await applyComposableCatalogRevisionSchema(c)
    await c.query('COMMIT')
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }
}
type Spec = {
  label: string
  legacy?: boolean
  writer?: 'retirement' | 'admin' | 'route' | 'managed' | 'handover'
  tombstone?: boolean
  audit?: boolean
  deleted?: boolean
  twoTeam?: boolean
  baseline?: boolean
  order?: 'writer-first' | 'retirement-first'
  child?: 'membership' | 'medium'
  runTeam?: string
}
type ExpandedFixture = Fixture & {
  receiver: string
  manager: string
  thirdTeam: string
  auditId?: string
  inviterAdmin?: string
  invitation?: string
  receiverEmail?: string
}

async function prelock(client: PoolClient, ids: string[]) {
  const role = (await client.query('SELECT current_user')).rows[0].current_user
  expect(role).toBe('control_api_runtime')
  await client.query('SELECT public.authorization_prelock_user_retirement_revisions($1::uuid[])', [
    ids,
  ])
  event({ phase: 'prelock-executed', role, ids })
}
async function expandedFixture(spec: Spec): Promise<ExpandedFixture> {
  const f = (await fixture(spec.label, false, !spec.legacy)) as ExpandedFixture
  f.receiver = randomUUID()
  f.manager = randomUUID()
  f.thirdTeam = randomUUID()
  for (const id of [f.receiver, f.manager]) {
    await databasePool.query("INSERT INTO users(id, email, name) VALUES ($1, $2, 'DB1 fixture')", [
      id,
      `db1-${id}@example.test`,
    ])
  }
  await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'DB1 third team')", [
    f.thirdTeam,
  ])
  if (spec.deleted)
    await databasePool.query("UPDATE team_members SET status='deleted' WHERE user_id=$1", [f.user])
  if (spec.writer === 'managed') {
    await databasePool.query(
      "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'admin','active')",
      [f.team, f.manager]
    )
  }
  if (spec.writer === 'handover') {
    await databasePool.query(
      "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active'),($3,$4,'member','active')",
      [f.secondTeam, f.user, f.thirdTeam, f.receiver]
    )
    f.inviterAdmin = randomUUID()
    f.invitation = randomUUID()
    f.receiverEmail = `db1-${f.receiver}@example.test`
    await databasePool.query(
      `INSERT INTO control_admin_users(id,username,email,password_hash,role,status)
      VALUES ($1,$2,$3,'scratch-unusable-hash','admin','active')`,
      [f.inviterAdmin, `db1-${f.inviterAdmin}`, `db1-${f.user}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO control_admin_invitations(id,email,invited_by_admin_id,replace_inviter)
      VALUES ($1,$2,$3,true)`,
      [f.invitation, f.receiverEmail, f.inviterAdmin]
    )
  }
  if (spec.audit || spec.twoTeam) {
    f.auditId = randomUUID()
    await databasePool.query(
      `INSERT INTO workflow_runs_audit(run_id,run_namespace,run_name,recipe_namespace,recipe_name,
      triggerer_user_id,triggerer_actor_type,triggerer_team_id,usage_team_id,trigger_source,idempotency_key,
      triggered_at,completed_at,final_phase,step_count,snapshot_sha)
      VALUES ($1,'db1-trace',$2,'db1-trace',$2,$3,'user',$4,$5,'onDemand',$2,NOW(),NOW(),'Succeeded',0,'scratch-design')`,
      [
        f.auditId,
        spec.label,
        f.user,
        spec.twoTeam ? f.thirdTeam : null,
        spec.twoTeam ? f.secondTeam.toUpperCase() : f.secondTeam,
      ]
    )
  }
  if (spec.legacy) {
    await databasePool.query('DELETE FROM authorization_user_revisions WHERE user_id=$1', [f.user])
    await databasePool.query('DELETE FROM authorization_team_revisions WHERE team_id=$1', [f.team])
  }

  if (receiverSetFixture && spec.writer === 'handover') {
    const additional = randomUUID()
    await databasePool.query(
      "INSERT INTO users(id,email,name) VALUES($1,$2,'case variant receiver')",
      [additional, f.receiverEmail!.toUpperCase()]
    )
    await seedLink(f.user, f.inviterAdmin!)
    await databasePool.query('UPDATE control_admin_users SET email=$2 WHERE id=$1', [
      f.inviterAdmin,
      `changed-admin-${f.inviterAdmin}@example.test`,
    ])
    extraReceivers.set(f.label, additional)
  }
  if (spec.writer === 'managed') await seedAuthority(f.manager)
  return f
}
async function expandedFinal(f: ExpandedFixture) {
  return {
    ...(await finalState(f)),
    receiverMemberships: (
      await databasePool.query(
        'SELECT team_id,role,status FROM team_members WHERE user_id=$1 ORDER BY team_id',
        [f.receiver]
      )
    ).rows,
    receiver: (
      await databasePool.query('SELECT id,lifecycle_state FROM users WHERE id=$1', [f.receiver])
    ).rows,
    inviter: (
      await databasePool.query(
        'SELECT status,session_version FROM control_admin_users WHERE id=$1',
        [f.inviterAdmin ?? actorId]
      )
    ).rows,
    audit: (
      await databasePool.query(
        'SELECT triggerer_user_id,triggerer_team_id,usage_team_id FROM workflow_runs_audit WHERE run_id=$1',
        [f.auditId ?? randomUUID()]
      )
    ).rows,
  }
}
function actorRun(client: PoolClient, f: ExpandedFixture, spec: Spec) {
  let team = spec.audit || spec.deleted ? (spec.deleted ? f.team : f.secondTeam) : f.team
  let usage = team
  if (spec.twoTeam) {
    // Intentionally reverse attribution; trigger order still uses TEXT keys.
    team = f.thirdTeam
    usage = f.secondTeam.toUpperCase()
  }
  if (spec.writer === 'handover') team = usage = spec.runTeam ?? f.secondTeam
  return createRun(
    {
      recipe_namespace: 'db1-trace',
      recipe_name: f.label,
      actor_type: 'user',
      actor_id: spec.writer === 'handover' ? f.receiver : f.user,
      team_id: team,
      usage_team_id: usage,
      idempotency_key: null,
      trigger_source: 'onDemand',
      ttl_seconds_after_finished: 2592000,
    },
    client
  )
}
async function runtimeBegin(client: PoolClient, application: string) {
  await begin(client, application)
  await client.query('SET LOCAL ROLE control_api_runtime')
}
function deletionWrite(client: PoolClient, f: ExpandedFixture, spec: Spec) {
  if (spec.writer === 'admin') return adminDeleteUserInTransaction(client, f.user)
  if (spec.writer === 'managed')
    return deleteManagedUserForUser(
      f.manager,
      f.user,
      { reason: 'DB1 regression', idempotencyKey: `phase1-${f.user}`, requestId: null },
      authorities.get(f.manager)
    )
  if (spec.writer === 'handover')
    return completeControlAdminInvitation({
      email: f.receiverEmail!,
      invitationId: f.invitation!,
      username: `receiver-${f.receiver}`,
      passwordHash: 'scratch-unusable-hash',
    })
  if (spec.writer === 'route') {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).adminAuth = { sub: actorId }
      next()
    })
    app.use(createAdminUsersRouter({} as any))
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ code: err.code }))
    return request(app)
      .delete(`/admin/users/${f.user}`)
      .set('Idempotency-Key', `phase1-${f.user}`)
      .send({ reason: 'DB1 regression' })
      .then(response => {
        if (response.status !== 200)
          throw Object.assign(new Error('Retirement route failed'), {
            code: response.body.code ?? response.status,
          })
        return { status: response.status, body: response.body }
      })
  }
  return retirementWrite(client, f, { tombstone: spec.tombstone })
}

// Only pool ownership and scheduling are test-specific. Every
// internal service query, BEGIN/COMMIT, authorize call and trigger still runs.
const serviceScope = new AsyncLocalStorage<PoolClient>()
const authorities = new Map<string, ExternalSessionAuthorityContext>()
let discoveryHook: (() => Promise<void>) | undefined
let beforeCopyHook: (() => Promise<void>) | undefined
let afterCopyValidationHook: (() => Promise<void>) | undefined
function installPoolRouting() {
  vi.spyOn(pool, 'connect').mockImplementation((() => {
    const client = serviceScope.getStore()
    if (!client) throw new Error('Service transaction escaped its test connection')
    return Promise.resolve(client)
  }) as any)
  vi.spyOn(pool, 'query').mockImplementation(((sql: string, values?: unknown[]) => {
    const client = serviceScope.getStore()
    if (!client) throw new Error('Service query escaped its test connection')
    return client.query(sql, values)
  }) as any)
}
async function seedAuthority(userId: string) {
  const c = await databasePool.connect()
  try {
    await c.query('BEGIN')
    const issued = await createUserSession(
      { userId, email: `db1-${userId}@example.test`, authenticationMethods: ['password'] },
      { db: c }
    )
    const { sid, jti, sessionVersion } = issued.identity
    authorities.set(userId, { contract: 'v2', userId, sid, jti, sessionVersion })
    await c.query('COMMIT')
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }
}

// Observe query boundaries only; do not add prelocks, change predicates,
// revalidate identities, or replace production errors in fixed cases.
function installObservation(
  client: PoolClient,
  spec: Spec,
  enabled: boolean,
  afterFirst?: () => Promise<void>
) {
  const raw = client.query.bind(client)
  const state = { count: 0, events: [] as any[], spy: undefined as any }
  let discoveryCount = 0
  let inviter: any, links: any[], sender: any
  let expected: any
  state.spy = vi.spyOn(client, 'query').mockImplementation((async (sql: string, values?: any[]) => {
    const isPrelock = sql.includes('SELECT public.authorization_prelock_user_retirement_revisions(')
    if (isPrelock && !enabled) {
      event({ phase: 'baseline-prelock-disabled', label: spec.label })
      return { rows: [], rowCount: 0 }
    }
    if (isPrelock && state.count === 0) await discoveryHook?.()
    const discoveryStart =
      sql === 'SELECT id::text AS id, email, status FROM control_admin_users WHERE id=$1'
    if (discoveryStart && discoveryCount === 2) await beforeCopyHook?.()
    const membershipCopy = sql.includes('INSERT INTO team_members(team_id, user_id, role, status)')
    if (membershipCopy) {
      await afterCopyValidationHook?.()
      state.events.push({ placement: 'handover-copy-bound', ids: values![1], sql })
    }
    const result = await raw(sql, values)
    if (isPrelock) {
      state.count++
      state.events.push({ placement: 'production-prelock', ids: values![0] })
      event({ phase: 'prelock-executed', label: spec.label, ids: values![0] })
      if (state.count === 1) await afterFirst?.()
    }
    if (discoveryStart) {
      inviter = result.rows[0]
      links = []
      sender = null
    }
    if (
      sql.includes(
        'SELECT link.id::text AS link_id, link.generation, link.state, link.row_version,'
      )
    ) {
      links = result.rows
      sender = links[0]?.lifecycle_state === 'active' ? links[0] : null
    }
    if (
      sql.includes('SELECT u.id::text AS id, u.email, u.lifecycle_state') &&
      sql.includes('l.control_admin_id<>$2::uuid')
    )
      sender = result.rows[0] ?? null
    if (sql.includes('SELECT id::text AS id, email, lifecycle_state FROM users')) {
      const snapshot = { inviter, links, sender, receivers: result.rows }
      discoveryCount++
      if (discoveryCount === 1) {
        expected = snapshot
        event({ phase: 'handover-discovery', label: spec.label, discovered: snapshot })
      } else if (discoveryCount === 2) {
        event({ phase: 'handover-revalidated', label: spec.label, snapshot })
      } else if (discoveryCount === 3) {
        event({
          phase: 'handover-copy-revalidation',
          label: spec.label,
          identical: JSON.stringify(expected) === JSON.stringify(snapshot),
          expected,
          current: snapshot,
        })
      }
    }
    if (membershipCopy)
      state.events.push({ placement: 'handover-copy-executed', rows: result.rowCount })
    if (
      sql.includes('FROM external_user_sessions') ||
      sql.includes("AND lifecycle_state = 'active'")
    ) {
      event({
        phase: 'internal-authority-query-executed',
        label: spec.label,
        sql,
        rows: result.rowCount,
      })
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      event({ phase: 'service-transaction', label: spec.label, sql, command: result.command })
    return result
  }) as any)
  return state
}

async function contention(spec: Spec, mode: 'baseline' | 'fixed' | 'mutation') {
  const f = await expandedFixture(spec)
  const actualMutation = mode === 'mutation' ? mutation : ''
  if (mode !== 'baseline' && actualMutation !== 'no-backfill') {
    const start = performance.now()
    const before = (
      await databasePool.query(
        'SELECT user_id,revision FROM authorization_user_revisions ORDER BY user_id'
      )
    ).rows
    await backfillRevisions()
    const covered = (
      await databasePool.query(
        'SELECT user_id,revision,updated_at FROM authorization_user_revisions ORDER BY user_id'
      )
    ).rows
    await backfillRevisions()
    const rerun = (
      await databasePool.query(
        'SELECT user_id,revision,updated_at FROM authorization_user_revisions ORDER BY user_id'
      )
    ).rows
    save(`${spec.label}.backfill`, { elapsedMs: performance.now() - start, before, covered, rerun })
    expect(rerun).toEqual(covered)
  }
  const clients = await Promise.all([
    databasePool.connect(),
    databasePool.connect(),
    databasePool.connect(),
  ])
  const [gate, deletion, run] = clients as [PoolClient, PoolClient, PoolClient]
  const retain = vi.spyOn(deletion, 'release').mockImplementation(() => undefined)
  const pending: Promise<Outcome>[] = []
  let querySpy: ReturnType<typeof vi.spyOn> | undefined
  const raw = deletion.query.bind(deletion)
  let paused = false
  const usePrelock =
    mode !== 'baseline' && actualMutation !== 'no-prelock' && actualMutation !== 'late-handover'
  const failureSchedule = mode === 'baseline' || mode === 'mutation'
  const app = `${spec.label}-delete`
  try {
    const [gatePid, deletionPid, runPid] = await Promise.all(clients.map(pid))
    await gate.query('SELECT pg_advisory_lock($1,1)', [barrierClass])
    await runtimeBegin(deletion, app)
    await runtimeBegin(run, `${spec.label}-run`)

    const observation = installObservation(
      deletion,
      spec,
      usePrelock || actualMutation === 'late-handover',
      (failureSchedule && !['no-audit', 'no-deleted'].includes(actualMutation)) ||
        spec.order === 'retirement-first'
        ? async () => {
            paused = true
            await raw('SELECT pg_advisory_xact_lock($1,1)', [barrierClass])
          }
        : undefined
    )
    querySpy = observation.spy
    if (failureSchedule && (!usePrelock || ['no-audit', 'no-deleted'].includes(actualMutation))) {
      if (spec.legacy) {
        if (spec.writer === 'admin')
          await databasePool.query('INSERT INTO db1_parent_barriers VALUES ($1,$2)', [app, f.user])
        else {
          // Take the same real parent lock used by retireDesktopUser; the
          // barrier here precedes its medium/cascade work, never a fake bump.
          await raw('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.user])
        }
      } else if (spec.writer !== 'handover')
        await revisionBarrier(app, 'authorization_user_revisions', f.user)
      else await revisionBarrier(app, 'authorization_user_revisions', f.receiver)
    }
    const deleteOutcome = () =>
      observe(
        deletion,
        (async () => {
          if (failureSchedule && !usePrelock && spec.legacy && spec.writer !== 'admin') {
            await raw('SELECT pg_advisory_xact_lock($1,1)', [barrierClass])
          }
          return serviceScope.run(deletion, () => deletionWrite(deletion, f, spec))
        })()
      )
    let one: Promise<Outcome>, two: Promise<Outcome>
    if (failureSchedule) {
      one = deleteOutcome()
      pending.push(one)
      await waitForEdges([[deletionPid, gatePid]])
      await snapshot(spec.label, '01-delete-held', [gatePid, deletionPid, runPid], f)
      if (spec.writer === 'handover' && !usePrelock) {
        // INSERT SELECT has no ORDER BY in production. Inspect which source
        // team the first real copy has touched, then contend on the OTHER
        // source team. Do not replace or order the production copy query.
        const held = (
          await databasePool.query(
            `SELECT r.team_id FROM pgrowlocks('authorization_team_revisions') p
          JOIN authorization_team_revisions r ON r.ctid=p.locked_row WHERE $1=ANY(p.pids)`,
            [deletionPid]
          )
        ).rows.map(r => r.team_id)
        spec.runTeam = [f.team, f.secondTeam].find(id => !held.includes(id))
        expect(spec.runTeam).toBeDefined()
        event({
          phase: 'handover-real-copy-order',
          label: spec.label,
          held,
          contendedTeam: spec.runTeam,
        })
      }
      two = observe(run, actorRun(run, f, spec))
      pending.push(two)
      await waitForEdges([[runPid, deletionPid]])
      await snapshot(spec.label, '02-run-blocked', [gatePid, deletionPid, runPid], f)
      await gate.query('SELECT pg_advisory_unlock($1,1)', [barrierClass])
      await waitForEdges([
        [runPid, deletionPid],
        [deletionPid, runPid],
      ])
      await snapshot(spec.label, '03-cycle', [gatePid, deletionPid, runPid], f)
    } else if (spec.order === 'retirement-first') {
      // Pause after the complete prelock; hard delete without a medium has no
      // later user-revision UPDATE on which to put a revision-trigger barrier.
      one = deleteOutcome()
      pending.push(one)
      await waitForEdges([[deletionPid, gatePid]])
      two = observe(run, actorRun(run, f, spec))
      pending.push(two)
      await waitForEdges([[runPid, deletionPid]])
      await snapshot(spec.label, '01-serialized-contention', [gatePid, deletionPid, runPid], f)
      await gate.query('SELECT pg_advisory_unlock($1,1)', [barrierClass])
    } else {
      const firstTeam =
        spec.writer === 'handover'
          ? f.secondTeam
          : spec.twoTeam
            ? (
                await databasePool.query(
                  'SELECT key FROM unnest($1::text[]) AS keys(key) ORDER BY key LIMIT 1',
                  [[f.thirdTeam, f.secondTeam.toUpperCase()]]
                )
              ).rows[0].key.toLowerCase()
            : spec.audit
              ? f.secondTeam
              : f.team
      await revisionBarrier(`${spec.label}-run`, 'authorization_team_revisions', firstTeam)
      two = observe(run, actorRun(run, f, spec))
      pending.push(two)
      await waitForEdges([[runPid, gatePid]])
      one = deleteOutcome()
      pending.push(one)
      await waitForEdges([[deletionPid, runPid]])
      await snapshot(spec.label, '01-serialized-contention', [gatePid, deletionPid, runPid], f)
      await gate.query('SELECT pg_advisory_unlock($1,1)', [barrierClass])
    }
    const outcomes = await Promise.all([one, two])
    const final = await expandedFinal(f)
    save(`${spec.label}.outcome`, {
      spec,
      mode,
      mutation: actualMutation,
      fixture: f,
      deletionPid,
      runPid,
      prelocked: observation.count > 0,
      observations: observation.events,
      paused,
      outcomes,
      final,
      runtimeRole: 'control_api_runtime',
    })
    console.info(
      'DB1_RESULT',
      spec.label,
      outcomes.map(o => (o.status === 'rejected' ? o.code : o.status))
    )
    if (mode === 'baseline') {
      expect(outcomes.filter(o => o.status === 'rejected' && o.code === '40P01')).toHaveLength(1)
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    } else {
      // Deliberately unchanged under each mutation: a real deadlock turns RED.
      expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(observation.count).toBeGreaterThan(0)
      expect(outcomes.every(o => o.transaction === 'COMMIT')).toBe(true)
      if (spec.tombstone || spec.writer === 'handover')
        expect(final.users[0]?.lifecycle_state).toBe('retired')
      else {
        expect(final.users).toHaveLength(0)
        expect(final.memberships).toHaveLength(0)
      }
      expect(final.medium.every(m => m.disabled)).toBe(true)
      expect(final.runs).toHaveLength(1)
      if (spec.audit || spec.twoTeam) expect(final.audit[0]?.triggerer_user_id).toBeNull()
      if (spec.writer === 'route')
        expect(outcomes[0]).toMatchObject({
          value: { status: 200, body: { deleted: true, id: f.user } },
        })
      if (spec.writer === 'managed')
        expect(outcomes[0]).toMatchObject({ value: { deleted: { ok: true, id: f.user } } })
      if (spec.writer === 'handover') {
        expect(final.receiver[0]?.lifecycle_state).toBe('active')
        expect(final.receiverMemberships).toHaveLength(3)
        expect(final.inviter[0]?.status).toBe('disabled')
        if (extraReceivers.has(f.label)) {
          const extra = (
            await databasePool.query(
              'SELECT team_id,status FROM team_members WHERE user_id=$1 ORDER BY team_id',
              [extraReceivers.get(f.label)]
            )
          ).rows
          expect(extra).toHaveLength(2)
          expect(extra.every(r => r.status === 'active')).toBe(true)
          save(`${spec.label}.receiver-set`, { extra, user: extraReceivers.get(f.label) })
        }
      }
    }
  } finally {
    await gate.query('SELECT pg_advisory_unlock_all()')
    await Promise.allSettled(pending)
    querySpy?.mockRestore()
    retain.mockRestore()
    for (const c of clients) {
      await c.query('ROLLBACK')
      c.release()
    }
    await databasePool.query('TRUNCATE db1_trace_barriers, db1_parent_barriers')
  }
}

describeRealPostgres('user retirement revision lock order on real PostgreSQL 16', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    const version = Number(
      (await adminPool.query('SHOW server_version_num')).rows[0].server_version_num
    )
    expect(version).toBeGreaterThanOrEqual(160000)
    expect(version).toBeLessThan(170000)
    expect(process.version).toMatch(/^v24\./)
    await adminPool.query(`CREATE DATABASE "${database}"`)
    target.pathname = `/${database}`
    databasePool = new Pool({ connectionString: target.toString(), max: 12 })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query('CREATE EXTENSION pgrowlocks')
    await databasePool.query(
      `INSERT INTO control_admin_users(id,username,password_hash,role,status)
      VALUES ($1,$2,'scratch-unusable-hash','admin','active')`,
      [actorId, `db1-${actorId}`]
    )
    await databasePool.query(`
      CREATE TABLE db1_trace_barriers(application_name TEXT, revision_table TEXT, subject_id TEXT);
      CREATE TABLE db1_parent_barriers(application_name TEXT, subject_id UUID);
      CREATE FUNCTION db1_trace_after_bump() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM db1_trace_barriers
          WHERE application_name = current_setting('application_name') AND revision_table = TG_TABLE_NAME
            AND subject_id = COALESCE(to_jsonb(NEW)->>'user_id',to_jsonb(NEW)->>'team_id'))
        THEN PERFORM pg_advisory_xact_lock(${barrierClass},1); END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER zz_db1_trace_after_bump AFTER INSERT OR UPDATE ON authorization_user_revisions
        FOR EACH ROW EXECUTE FUNCTION db1_trace_after_bump();
      CREATE TRIGGER zz_db1_trace_after_bump AFTER INSERT OR UPDATE ON authorization_team_revisions
        FOR EACH ROW EXECUTE FUNCTION db1_trace_after_bump();
      CREATE FUNCTION db1_before_parent_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM db1_parent_barriers WHERE application_name=current_setting('application_name') AND subject_id=OLD.id)
        THEN PERFORM pg_advisory_xact_lock(${barrierClass},1); END IF;
        RETURN OLD;
      END; $$;
      CREATE TRIGGER zz_db1_before_parent_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION db1_before_parent_delete();
      GRANT SELECT ON db1_parent_barriers TO control_api_runtime;
    `)
    installPoolRouting()
    await installChildBarriers()
    save('environment', {
      node: process.version,
      nodeExecPath: process.execPath,
      postgres: (await databasePool.query('SELECT version()')).rows,
      mutation,
      privileges: (
        await databasePool.query(`SELECT relname,
        has_table_privilege('control_api_runtime',oid,'SELECT') AS can_select,
        has_table_privilege('control_api_runtime',oid,'UPDATE') AS can_update
        FROM pg_class WHERE relname IN ('authorization_user_revisions','authorization_team_revisions')`)
      ).rows,
      function: (
        await databasePool.query(`SELECT proowner::regrole::text,prosecdef,proconfig,proacl FROM pg_proc
        WHERE proname='authorization_prelock_user_retirement_revisions'`)
      ).rows,
      constraints: (
        await databasePool.query(`SELECT conrelid::regclass::text,conname,confrelid::regclass::text,pg_get_constraintdef(oid)
        FROM pg_constraint WHERE contype='f' AND confrelid='users'::regclass ORDER BY conname`)
      ).rows,
      triggers: (
        await databasePool.query(`SELECT tgrelid::regclass::text,tgname,pg_get_triggerdef(oid)
        FROM pg_trigger WHERE tgrelid IN ('users'::regclass,'team_members'::regclass,'workflow_runs'::regclass,'workflow_runs_audit'::regclass)
        ORDER BY tgrelid,tgname`)
      ).rows,
    })
  }, 60_000)
  afterAll(async () => {
    try {
      vi.restoreAllMocks()
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
    }
  })
  for (const spec of [
    { label: 'baseline-A-admin', legacy: true, writer: 'admin' },
    { label: 'baseline-A-hard-delete', legacy: true },
    { label: 'baseline-B-medium' },
    { label: 'baseline-B-admin', writer: 'admin' },
    { label: 'baseline-A-tombstone', legacy: true, tombstone: true },
    { label: 'baseline-B-route', writer: 'route' },
    { label: 'baseline-handover', writer: 'handover' },
  ] as Spec[])
    it(spec.label + ' reproduces 40P01', () => contention(spec, 'baseline'))
  for (const spec of [
    { label: 'fixed-A-hard-delete', legacy: true },
    { label: 'fixed-A-admin', legacy: true, writer: 'admin' },
    { label: 'fixed-B-medium' },
    { label: 'fixed-B-admin', writer: 'admin' },
    { label: 'fixed-A-tombstone', legacy: true, tombstone: true },
    { label: 'fixed-B-tombstone', tombstone: true },
    { label: 'fixed-route', writer: 'route' },
    { label: 'fixed-managed', writer: 'managed' },
    { label: 'fixed-handover', writer: 'handover' },
    { label: 'fixed-deleted-membership', deleted: true },
    { label: 'fixed-audit-team', audit: true },
    { label: 'fixed-two-team-run', twoTeam: true },
  ] as Spec[])
    for (const order of ['writer-first', 'retirement-first'] as const) {
      const ordered = { ...spec, order, label: `${spec.label}-${order}` }
      it(ordered.label + ' serializes under runtime role', () =>
        contention(ordered, mutation && !mutation.startsWith('toctou-') ? 'mutation' : 'fixed')
      )
    }
  for (const spec of [
    { label: 'fixed-membership-route', child: 'membership', writer: 'route' },
    { label: 'fixed-membership-managed', child: 'membership', writer: 'managed' },
    { label: 'fixed-membership-handover', child: 'membership', writer: 'handover' },
    { label: 'fixed-medium-hard-delete', child: 'medium' },
    { label: 'fixed-medium-tombstone', child: 'medium', tombstone: true },
    { label: 'fixed-medium-handover', child: 'medium', writer: 'handover' },
  ] as Spec[])
    for (const order of ['writer-first', 'retirement-first'] as const) {
      const ordered = { ...spec, order, label: `${spec.label}-${order}` }
      it(ordered.label, () => childContention(ordered, false))
    }
  registerErrors()
  registerOnlineBackfill()
  registerToctouTests()
  registerCollationTest()

  it('runtime role cannot lock revision tables directly; scoped definer succeeds without revision changes', async () => {
    const f = await expandedFixture({ label: 'privilege-witness', deleted: true, twoTeam: true })
    const c = await databasePool.connect()
    try {
      await runtimeBegin(c, 'privilege-witness')
      await c.query('SAVEPOINT privilege_probe')
      const forbidden = await c
        .query('SELECT * FROM authorization_team_revisions WHERE team_id=$1 FOR UPDATE', [f.team])
        .then(
          () => null,
          e => ({ code: e.code, message: e.message })
        )
      expect(forbidden?.code).toBe('42501')
      await c.query('ROLLBACK TO SAVEPOINT privilege_probe')
      const before = (
        await c.query('SELECT * FROM authorization_user_revisions WHERE user_id=$1', [f.user])
      ).rows
      await prelock(c, [f.user])
      const after = (
        await c.query('SELECT * FROM authorization_user_revisions WHERE user_id=$1', [f.user])
      ).rows
      expect(after).toEqual(before)
      save('runtime-privilege-witness', {
        forbidden,
        before,
        after,
        role: (await c.query('SELECT current_user')).rows,
        held: (await databasePool.query("SELECT * FROM pgrowlocks('authorization_team_revisions')"))
          .rows,
      })
      await c.query('ROLLBACK')
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  it('union mapping includes deleted memberships and raw audit TEXT while excluding sentinel NULL and empty', async () => {
    const f = await expandedFixture({ label: 'union-mapping', deleted: true, twoTeam: true })
    for (const usage of [null, '', 'control-plane-admin-ui']) {
      await databasePool.query(
        `INSERT INTO workflow_runs_audit(run_id,run_namespace,run_name,recipe_namespace,recipe_name,
          triggerer_user_id,triggerer_actor_type,usage_team_id,trigger_source,idempotency_key,triggered_at,completed_at,
          final_phase,step_count,snapshot_sha) VALUES (gen_random_uuid(),'db1-trace','mapping','db1-trace','mapping',
          $1,'user',$2,'onDemand','mapping',NOW(),NOW(),'Succeeded',0,'scratch-design')`,
        [f.user, usage]
      )
    }
    const keys = (
      await databasePool.query(
        `SELECT subject_id FROM (
        SELECT team_id::text AS subject_id FROM team_members WHERE user_id=$1
        UNION SELECT s.subject_id FROM workflow_runs_audit a CROSS JOIN LATERAL (VALUES
          (a.triggerer_team_id::text),(CASE WHEN a.usage_team_id='control-plane-admin-ui' THEN NULL ELSE a.usage_team_id END)) s(subject_id)
          WHERE a.triggerer_user_id=$1 AND s.subject_id IS NOT NULL AND s.subject_id<>''
        ) affected ORDER BY subject_id`,
        [f.user]
      )
    ).rows.map(r => r.subject_id)
    expect(keys).toHaveLength(3)
    expect(keys).toEqual(expect.arrayContaining([f.team, f.thirdTeam, f.secondTeam.toUpperCase()]))
    const c = await databasePool.connect()
    try {
      await runtimeBegin(c, 'union-mapping')
      await prelock(c, [f.user])
      const pidValue = await pid(c)
      const locks = (
        await databasePool.query(
          `SELECT r.team_id::text,p.* FROM pgrowlocks('authorization_team_revisions') p
          JOIN authorization_team_revisions r ON r.ctid=p.locked_row WHERE $1=ANY(p.pids) ORDER BY r.team_id`,
          [pidValue]
        )
      ).rows
      expect(locks.map(r => r.team_id).sort()).toEqual([f.team, f.secondTeam, f.thirdTeam].sort())
      save('union-mapping-witness', { fixture: f, keys, locks })
      await c.query('ROLLBACK')
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  it('definer parent lock blocks a new membership at the real users KEY SHARE FK', async () => {
    const f = await expandedFixture({ label: 'parent-fk-witness' })
    const clients = await Promise.all([databasePool.connect(), databasePool.connect()])
    const [owner, insert] = clients as [PoolClient, PoolClient]
    let pending: Promise<Outcome> | undefined
    try {
      await runtimeBegin(owner, 'parent-fk-owner')
      await prelock(owner, [f.user])
      await runtimeBegin(insert, 'parent-fk-insert')
      const ownerPid = await pid(owner),
        insertPid = await pid(insert)
      pending = observe(
        insert,
        insert.query(
          "INSERT INTO team_members(team_id,user_id,role,status) VALUES($1,$2,'member','active')",
          [f.secondTeam, f.user]
        )
      )
      await waitForEdges([[insertPid, ownerPid]])
      await snapshot('parent-fk-witness', '01-membership-blocked', [ownerPid, insertPid], f)
      await databasePool.query('SELECT pg_cancel_backend($1)', [insertPid])
      const outcome = await pending
      expect(outcome).toMatchObject({
        status: 'rejected',
        code: '57014',
        where: expect.stringContaining('FOR KEY SHARE'),
      })
      save('parent-fk-witness.outcome', { outcome })
    } finally {
      await owner.query('ROLLBACK')
      await pending
      for (const c of clients) {
        await c.query('ROLLBACK')
        c.release()
      }
    }
  })
  it('uncontended control commits real run then retirement', async () => {
    const f = await expandedFixture({ label: 'uncontended-control' })
    const c = await databasePool.connect()
    try {
      await runtimeBegin(c, 'uncontended-run')
      const run = await observe(c, runWrite(c, f))
      await runtimeBegin(c, 'uncontended-retirement')
      await prelock(c, [f.user])
      const retirement = await observe(c, retirementWrite(c, f))
      expect([run.status, retirement.status]).toEqual(['fulfilled', 'fulfilled'])
      save('uncontended-control.outcome', { run, retirement, final: await finalState(f) })
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
})

async function installChildBarriers() {
  await databasePool.query(`
    CREATE TABLE db1_child_barriers(application_name TEXT, child_table TEXT, user_id UUID);
    CREATE FUNCTION db1_before_child_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM db1_child_barriers WHERE application_name=current_setting('application_name')
        AND child_table=TG_TABLE_NAME AND user_id=NEW.user_id)
      THEN PERFORM pg_advisory_xact_lock(${barrierClass},2); END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER db1_child_pause BEFORE UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION db1_before_child_update();
    CREATE TRIGGER db1_child_pause BEFORE UPDATE ON workflow_approval_medium_accounts FOR EACH ROW EXECUTE FUNCTION db1_before_child_update();
    GRANT SELECT ON db1_child_barriers TO control_api_runtime;
  `)
}
async function childContention(spec: Spec, mutated: boolean) {
  const f = await expandedFixture(spec)
  await backfillRevisions()
  const clients = await Promise.all([
    databasePool.connect(),
    databasePool.connect(),
    databasePool.connect(),
  ])
  const [gate, deletion, writer] = clients as [PoolClient, PoolClient, PoolClient]
  const retains = [deletion, writer].map(c =>
    vi.spyOn(c, 'release').mockImplementation(() => undefined)
  )
  const pending: Promise<Outcome>[] = []
  const raw = deletion.query.bind(deletion)
  const writerFirst = spec.order !== 'retirement-first'
  const observation = installObservation(
    deletion,
    spec,
    true,
    mutated
      ? async () => {
          await raw('SELECT pg_advisory_xact_lock($1,1)', [barrierClass])
        }
      : undefined
  )
  try {
    const [gatePid, deletionPid, writerPid] = await Promise.all(clients.map(pid))
    await gate.query('SELECT pg_advisory_lock($1,1), pg_advisory_lock($1,2)', [barrierClass])
    await runtimeBegin(deletion, `${spec.label}-delete`)
    await runtimeBegin(writer, `${spec.label}-writer`)
    const account = (
      await databasePool.query(
        'SELECT id FROM workflow_approval_medium_accounts WHERE user_id=$1',
        [f.user]
      )
    ).rows[0]?.id
    const write = () =>
      observe(
        writer,
        serviceScope.run(writer, () =>
          spec.child === 'membership'
            ? updateMemberRole(f.team, f.user, 'inviter', actorId)
            : preferVerifiedMediumAccount({ userId: f.user, accountId: account })
        )
      )
    const retire = () =>
      observe(
        deletion,
        serviceScope.run(deletion, () => deletionWrite(deletion, f, spec))
      )
    let one: Promise<Outcome>, two: Promise<Outcome>
    if (writerFirst) {
      await databasePool.query('INSERT INTO db1_child_barriers VALUES($1,$2,$3)', [
        `${spec.label}-writer`,
        spec.child === 'membership' ? 'team_members' : 'workflow_approval_medium_accounts',
        f.user,
      ])
      two = write()
      pending.push(two)
      await waitForEdges([[writerPid, gatePid]])
      one = retire()
      pending.push(one)
      if (mutated) {
        await waitForEdges([[deletionPid, gatePid]])
        await snapshot(spec.label, '01-prelock-held', [gatePid, deletionPid, writerPid], f)
        await gate.query('SELECT pg_advisory_unlock($1,1)', [barrierClass])
        await waitForEdges([[deletionPid, writerPid]])
        await snapshot(spec.label, '02-child-blocked', [gatePid, deletionPid, writerPid], f)
        await gate.query('SELECT pg_advisory_unlock($1,2)', [barrierClass])
        await waitForEdges([
          [deletionPid, writerPid],
          [writerPid, deletionPid],
        ])
        await snapshot(spec.label, '03-cycle', [gatePid, deletionPid, writerPid], f)
      } else {
        await waitForEdges([[deletionPid, writerPid]])
        await snapshot(spec.label, '01-serialized-contention', [gatePid, deletionPid, writerPid], f)
        await gate.query('SELECT pg_advisory_unlock($1,2)', [barrierClass])
      }
    } else {
      // Retire first through its actual medium disable / receiver copy. The
      // second writer then sees the committed disabled/deleted/retired state.
      await revisionBarrier(`${spec.label}-delete`, 'authorization_user_revisions', f.user)
      one = retire()
      pending.push(one)
      await waitForEdges([[deletionPid, gatePid]])
      two = write()
      pending.push(two)
      await waitForEdges([[writerPid, deletionPid]])
      await snapshot(spec.label, '01-serialized-contention', [gatePid, deletionPid, writerPid], f)
      await gate.query('SELECT pg_advisory_unlock($1,1)', [barrierClass])
    }
    const outcomes = await Promise.all([one, two])
    const final = await expandedFinal(f)
    save(`${spec.label}.outcome`, {
      spec,
      mutation: mutated ? mutation : '',
      fixture: f,
      deletionPid,
      writerPid,
      outcomes,
      final,
      observations: observation.events,
      runtimeRole: 'control_api_runtime',
    })
    console.info(
      'DB1_CHILD_RESULT',
      spec.label,
      outcomes.map(o => (o.status === 'rejected' ? o.code : o.transaction))
    )
    // These fixed assertions remain unchanged for mutations; 40P01 makes RED.
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(outcomes.every(o => o.transaction === 'COMMIT')).toBe(true)
    if (spec.tombstone || spec.writer === 'handover')
      expect(final.users[0]?.lifecycle_state).toBe('retired')
    else {
      expect(final.users).toHaveLength(0)
      expect(final.memberships).toHaveLength(0)
    }
    expect(final.medium.every(m => m.disabled)).toBe(true)
    if (spec.writer === 'managed')
      expect(outcomes[0]).toMatchObject({ value: { deleted: { ok: true, id: f.user } } })
    if (spec.writer === 'handover') {
      expect(final.receiver[0]?.lifecycle_state).toBe('active')
      expect(final.receiverMemberships).toHaveLength(3)
      expect(final.inviter[0]?.status).toBe('disabled')
    }
    if (writerFirst) expect((outcomes[1] as any).value).toBeTruthy()
    else if (spec.child === 'medium') expect((outcomes[1] as any).value).toBeNull()
  } finally {
    await gate.query('SELECT pg_advisory_unlock_all()')
    await Promise.allSettled(pending)
    observation.spy.mockRestore()
    retains.forEach(s => s.mockRestore())
    for (const c of clients) {
      await c.query('ROLLBACK')
      c.release()
    }
    await databasePool.query('TRUNCATE db1_child_barriers,db1_trace_barriers,db1_parent_barriers')
  }
}

async function withObservedClient<T>(
  spec: Spec,
  work: (c: PoolClient, observation: ReturnType<typeof installObservation>) => Promise<T>
) {
  const c = await databasePool.connect()
  const retain = vi.spyOn(c, 'release').mockImplementation(() => undefined)
  const observation = installObservation(c, spec, true)
  try {
    await runtimeBegin(c, spec.label)
    return await serviceScope.run(c, () => work(c, observation))
  } finally {
    observation.spy.mockRestore()
    retain.mockRestore()
    await c.query('ROLLBACK')
    c.release()
  }
}
async function seedLink(userId: string, adminId: string) {
  await databasePool.query(
    `INSERT INTO gfs_desktop_operator_links
    (id,lineage_id,generation,user_id,control_admin_id,state,source,created_by,row_version)
    VALUES(gen_random_uuid(),gen_random_uuid(),1,$1,$2,'active','initial_setup',$2,1)`,
    [userId, adminId]
  )
}
function registerErrors() {
  for (const which of ['target', 'manager'] as const)
    it(`managed malformed ${which} preserves error contract and filters principalIds`, async () => {
      const spec: Spec = { label: `error-managed-${which}`, writer: 'managed' }
      const f = await expandedFixture(spec)
      const manager = which === 'manager' ? 'malformed-manager' : f.manager
      const target = which === 'target' ? 'not-a-uuid' : f.user.toUpperCase()
      const result = await withObservedClient(spec, async (_c, observation) => {
        const value = await deleteManagedUserForUser(
          manager,
          target,
          { reason: 'DB1 error', idempotencyKey: randomUUID(), requestId: null },
          which === 'target' ? authorities.get(f.manager) : undefined
        )
        const batch = (observation.events[0] as any).ids
        expect(batch).toEqual([which === 'target' ? f.manager : f.user])
        return { value, batch }
      })
      expect(result.value).toEqual({ error: 'invalid_retirement_input' })
      expect((await expandedFinal(f)).users[0]?.lifecycle_state).toBe('active')
      save(spec.label, result)
    })
  for (const which of ['not-found', 'retained-history'] as const)
    it(`admin-delete ${which} preserves refusal`, async () => {
      const spec: Spec = { label: `error-admin-${which}`, writer: 'admin' }
      const f = await expandedFixture(spec)
      if (which === 'retained-history') await seedLink(f.user, actorId)
      const id = which === 'not-found' ? randomUUID() : f.user
      const result = await withObservedClient(spec, async (c, observation) => ({
        outcome: await observe(c, adminDeleteUserInTransaction(c, id)),
        observations: observation.events,
      }))
      expect(result.outcome).toMatchObject({
        status: 'fulfilled',
        transaction: 'COMMIT',
        value: {
          error: which === 'not-found' ? 'not_found' : 'gfs_operator_link_history_retained',
        },
      })
      const final = await expandedFinal(f)
      expect(final.users[0]?.lifecycle_state).toBe('active')
      expect(final.medium).toEqual([{ disabled: false }])
      save(spec.label, { ...result, final })
    })
  it('completed-operation replay returns before retirement prelock even after hard delete', async () => {
    const spec: Spec = { label: 'error-completed-replay' }
    const f = await expandedFixture(spec)
    const first = await withObservedClient(spec, async (c, observation) => ({
      outcome: await observe(c, retirementWrite(c, f)),
      count: observation.count,
    }))
    const second = await withObservedClient(spec, async (c, observation) => ({
      outcome: await observe(c, retirementWrite(c, f)),
      count: observation.count,
    }))
    expect(first.outcome).toMatchObject({
      status: 'fulfilled',
      value: { replayed: false, outcome: 'deleted' },
    })
    expect(second.outcome).toMatchObject({
      status: 'fulfilled',
      value: { replayed: true, outcome: 'deleted' },
    })
    expect(first.count).toBe(1)
    expect(second.count).toBe(0)
    expect((await expandedFinal(f)).operations).toEqual([
      { status: 'completed', outcome: 'deleted' },
    ])
    save(spec.label, { first, second, final: await expandedFinal(f) })
  })
  for (const which of ['self', 'missing'] as const)
    it(`real handover discovery refuses ${which} receiver`, async () => {
      const spec: Spec = { label: `error-handover-${which}`, writer: 'handover' }
      const f = await expandedFixture(spec)
      if (which === 'self') {
        await seedLink(f.user, f.inviterAdmin!)
        await databasePool.query('UPDATE control_admin_users SET email=$2 WHERE id=$1', [
          f.inviterAdmin,
          `other-${f.inviterAdmin}@example.test`,
        ])
        f.receiverEmail = `db1-${f.user}@example.test`
        await databasePool.query('UPDATE control_admin_invitations SET email=$2 WHERE id=$1', [
          f.invitation,
          f.receiverEmail,
        ])
      } else await databasePool.query('DELETE FROM users WHERE id=$1', [f.receiver])
      const outcome = await withObservedClient(spec, async c =>
        observe(c, Promise.resolve(deletionWrite(c, f, spec)))
      )
      expect(outcome).toMatchObject({
        status: 'fulfilled',
        value: { error: 'replace_inviter_receiver_missing' },
      })
      const final = await expandedFinal(f)
      expect(final.users[0]?.lifecycle_state).toBe('active')
      expect(final.inviter[0]?.status).toBe('active')
      const invitation = (
        await databasePool.query(
          'SELECT status,accepted_admin_id FROM control_admin_invitations WHERE id=$1',
          [f.invitation]
        )
      ).rows
      expect(invitation).toEqual([{ status: 'pending', accepted_admin_id: null }])
      save(spec.label, { outcome, final, invitation })
    })
  for (const which of ['email', 'link'] as const)
    it(`real handover discovery fails closed on concurrent ${which} change`, async () => {
      const spec: Spec = { label: `error-handover-race-${which}`, writer: 'handover' }
      const f = await expandedFixture(spec)
      if (which === 'link') await seedLink(f.user, f.inviterAdmin!)
      const changer = await databasePool.connect()
      let changed!: () => void
      const changeStarted = new Promise<void>(resolve => (changed = resolve))
      let pending: Promise<Outcome> | undefined
      try {
        await begin(changer, `${spec.label}-change`)
        discoveryHook = async () => {
          // Both operations use existing rows. Email changes hold the receiver
          // user row; link version changes hold its real FK-referenced user.
          if (which === 'email')
            await changer.query('UPDATE users SET email=$2 WHERE id=$1', [
              f.receiver,
              `changed-${f.receiver}@example.test`,
            ])
          else {
            await changer.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.user])
            await changer.query(
              'UPDATE gfs_desktop_operator_links SET row_version=row_version+1 WHERE user_id=$1',
              [f.user]
            )
          }
          changed()
        }
        pending = withObservedClient(spec, async c =>
          observe(c, Promise.resolve(deletionWrite(c, f, spec)))
        )
        await changeStarted
        const changerPid = await pid(changer)
        const d = (
          await databasePool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [
            spec.label,
          ])
        ).rows[0].pid
        await waitForEdges([[d, changerPid]])
        await snapshot(spec.label, '01-identity-change-blocked', [d, changerPid], f)
        await changer.query('COMMIT')
        const outcome = await pending
        expect(outcome).toMatchObject({
          status: 'rejected',
          code: 'handover_identity_changed',
          transaction: 'ROLLBACK',
        })
        const final = await expandedFinal(f)
        expect(final.users[0]?.lifecycle_state).toBe('active')
        expect(final.inviter[0]?.status).toBe('active')
        expect(final.receiverMemberships).toHaveLength(1)
        const invitation = (
          await databasePool.query(
            'SELECT status,accepted_admin_id FROM control_admin_invitations WHERE id=$1',
            [f.invitation]
          )
        ).rows
        expect(invitation).toEqual([{ status: 'pending', accepted_admin_id: null }])
        save(spec.label, { outcome, final, invitation })
      } finally {
        discoveryHook = undefined
        await changer.query('ROLLBACK')
        await pending
        changer.release()
      }
    })
  for (const order of ['writer-first', 'retirement-first'] as const)
    it(`handover discovers case-insensitive receiver SET and linked sender ${order}`, async () => {
      const spec: Spec = { label: `fixed-handover-set-${order}`, writer: 'handover', order }
      // The common fixture creates the sender email mapping. Add a second active
      // receiver differing only by case; UNIQUE(email) permits both identities.
      receiverSetFixture = true
      try {
        await contention(spec, 'fixed')
      } finally {
        receiverSetFixture = false
      }
    })
}
let receiverSetFixture = false

function registerOnlineBackfill() {
  it('Q1 short teams-before-users backfill aborts lock wait before deadlock and resumes with coverage', async () => {
    const spec: Spec = { label: 'online-backfill-timeout', legacy: true }
    const f = await expandedFixture(spec)
    const clients = await Promise.all([
      databasePool.connect(),
      databasePool.connect(),
      databasePool.connect(),
    ])
    const [gate, retire, batch] = clients as [PoolClient, PoolClient, PoolClient]
    const raw = retire.query.bind(retire)
    const observation = installObservation(retire, spec, true, () =>
      raw('SELECT pg_advisory_xact_lock($1,1)', [barrierClass]).then(() => undefined)
    )
    const pending: Promise<Outcome>[] = []
    try {
      const [gatePid, retirePid, batchPid] = await Promise.all(clients.map(pid))
      await gate.query('SELECT pg_advisory_lock($1,1)', [barrierClass])
      await runtimeBegin(retire, 'online-backfill-retirement')
      await begin(batch, 'online-backfill-batch')
      await batch.query("SET LOCAL lock_timeout='750ms'")
      const retirement = observe(retire, retirementWrite(retire, f))
      pending.push(retirement)
      await waitForEdges([[retirePid, gatePid]])
      // Deliberately overlap missing-row coverage with a retirement. A small
      // batch and lock_timeout < deadlock_timeout fail closed, then resume.
      await batch.query(
        `INSERT INTO authorization_team_revisions(team_id,revision,updated_at)
        SELECT id,1,clock_timestamp() FROM teams WHERE id=$1 ORDER BY id ON CONFLICT DO NOTHING`,
        [f.team]
      )
      const backfill = observe(
        batch,
        batch.query(
          `INSERT INTO authorization_user_revisions(user_id,revision,updated_at)
        SELECT id,1,clock_timestamp() FROM users WHERE id=$1 ORDER BY id ON CONFLICT DO NOTHING`,
          [f.user]
        )
      )
      pending.push(backfill)
      await waitForEdges([[batchPid, retirePid]])
      await gate.query('SELECT pg_advisory_unlock($1,1)', [barrierClass])
      await waitForEdges([
        [batchPid, retirePid],
        [retirePid, batchPid],
      ])
      await snapshot(spec.label, '01-timeout-protected-cycle', [gatePid, retirePid, batchPid], f)
      const outcomes = await Promise.all([retirement, backfill])
      expect(outcomes[0]).toMatchObject({ status: 'fulfilled', transaction: 'COMMIT' })
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        code: '55P03',
        transaction: 'ROLLBACK',
      })
      await backfillRevisions()
      const uncovered = (
        await databasePool.query(`SELECT
        (SELECT count(*)::int FROM users u LEFT JOIN authorization_user_revisions r ON r.user_id=u.id WHERE r.user_id IS NULL) AS users,
        (SELECT count(*)::int FROM teams t LEFT JOIN authorization_team_revisions r ON r.team_id=t.id WHERE r.team_id IS NULL) AS teams`)
      ).rows[0]
      expect(uncovered).toEqual({ users: 0, teams: 0 })
      save(spec.label, {
        outcomes,
        uncovered,
        lockTimeoutMs: 750,
        deadlockTimeoutMs: 2000,
        final: await expandedFinal(f),
      })
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()')
      await Promise.allSettled(pending)
      observation.spy.mockRestore()
      for (const c of clients) {
        await c.query('ROLLBACK')
        c.release()
      }
    }
  })
}

const extraReceivers = new Map<string, string>()

function registerToctouTests() {
  for (const phase of [
    'email-before-copy',
    'link-before-copy',
    'email-after-validation',
  ] as const) {
    it(`TOCTOU ${phase} closes handover identity set`, async () => {
      const spec: Spec = { label: `toctou-${phase}`, writer: 'handover' }
      const f = await expandedFixture(spec)
      await seedLink(f.user, f.inviterAdmin!)
      const phantom = f.manager,
        phantomTeam = randomUUID()
      await databasePool.query("INSERT INTO teams(id,name) VALUES($1,'TOCTOU phantom team')", [
        phantomTeam,
      ])
      await databasePool.query(
        "INSERT INTO team_members(team_id,user_id,role,status) VALUES($1,$2,'member','active')",
        [phantomTeam, phantom]
      )
      await backfillRevisions()
      const before = await expandedFinal(f)
      const changer = await databasePool.connect()
      const changerPid = await pid(changer)
      let prelockedIds: string[] = [],
        heldTeams: string[] = []
      let observations: unknown[] = []
      try {
        await begin(changer, `${spec.label}-change`)
        const change = async () => {
          const handoverPid = (
            await databasePool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [
              spec.label,
            ])
          ).rows[0].pid
          prelockedIds = (
            await databasePool.query(
              `SELECT u.id FROM pgrowlocks('users') p JOIN users u ON u.ctid=p.locked_row
            WHERE $1=ANY(p.pids) ORDER BY u.id`,
              [handoverPid]
            )
          ).rows.map(r => r.id)
          heldTeams = (
            await databasePool.query(
              `SELECT r.team_id FROM pgrowlocks('authorization_team_revisions') p
            JOIN authorization_team_revisions r ON r.ctid=p.locked_row WHERE $1=ANY(p.pids) ORDER BY r.team_id`,
              [handoverPid]
            )
          ).rows.map(r => r.team_id)
          expect(prelockedIds).toEqual([f.user, f.receiver].sort())
          expect(prelockedIds).not.toContain(phantom)
          expect(heldTeams).not.toContain(phantomTeam)
          await snapshot(spec.label, '01-after-prelock-before-change', [handoverPid, changerPid], f)
          const result =
            phase === 'link-before-copy'
              ? await changer.query(
                  'UPDATE gfs_desktop_operator_links SET row_version=row_version+1 WHERE user_id=$1',
                  [f.user]
                )
              : await changer.query('UPDATE users SET email=$2 WHERE id=$1', [
                  phantom,
                  f.receiverEmail!.toUpperCase(),
                ])
          expect(result.rowCount).toBe(1)
          await changer.query('COMMIT')
          const matching = (
            await databasePool.query(
              "SELECT id FROM users WHERE lower(email)=lower($1) AND lifecycle_state='active' ORDER BY id",
              [f.receiverEmail]
            )
          ).rows.map(r => r.id)
          event({
            phase: 'toctou-change-committed',
            label: spec.label,
            moment: phase,
            prelockedIds,
            heldTeams,
            phantom,
            phantomTeam,
            matching,
          })
        }
        if (phase === 'email-after-validation') afterCopyValidationHook = change
        else beforeCopyHook = change
        const outcome = await withObservedClient(spec, async (c, observation) => {
          const result = await observe(c, Promise.resolve(deletionWrite(c, f, spec)))
          observations = observation.events
          return result
        })
        const final = await expandedFinal(f)
        const phantomMemberships = (
          await databasePool.query(
            'SELECT team_id,role,status FROM team_members WHERE user_id=$1 ORDER BY team_id',
            [phantom]
          )
        ).rows
        const invitation = (
          await databasePool.query(
            'SELECT status,accepted_admin_id FROM control_admin_invitations WHERE id=$1',
            [f.invitation]
          )
        ).rows
        const newAdmins = (
          await databasePool.query('SELECT id,status FROM control_admin_users WHERE email=$1', [
            f.receiverEmail,
          ])
        ).rows
        const trace = events.filter(e => e.label === spec.label)
        // Persist the actual wrong copy/COMMIT before an unchanged assertion
        // rejects the mutation. A RED is not inferred from a test exit alone.
        save(spec.label, {
          mutation,
          phase,
          fixture: f,
          phantom,
          phantomTeam,
          prelockedIds,
          heldTeams,
          outcome,
          before,
          final,
          phantomMemberships,
          invitation,
          newAdmins,
          observations,
          trace,
        })
        expect(trace.filter(e => e.phase === 'handover-revalidated')).toHaveLength(1)
        const comparisons = trace.filter(e => e.phase === 'handover-copy-revalidation')
        expect(comparisons).toHaveLength(1)
        if (phase === 'email-after-validation') {
          expect(comparisons[0].identical).toBe(true)
          expect(outcome).toMatchObject({ status: 'fulfilled', transaction: 'COMMIT' })
          expect(final.users[0]?.lifecycle_state).toBe('retired')
          expect(final.receiverMemberships).toHaveLength(3)
          expect(phantomMemberships).toEqual([
            { team_id: phantomTeam, role: 'member', status: 'active' },
          ])
          const copy = observations.find((e: any) => e.placement === 'handover-copy-bound') as any
          expect(copy.ids).toEqual([f.receiver])
          expect(copy.sql).toContain('ON target.id = ANY($2::uuid[])')
        } else {
          expect(comparisons[0].identical).toBe(false)
          expect(outcome).toMatchObject({
            status: 'rejected',
            code: 'handover_identity_changed',
            errorName: 'HandoverIdentityChangedError',
            message: 'handover identity changed: before-membership-copy',
            transaction: 'ROLLBACK',
          })
          expect(final).toEqual(before)
          expect(phantomMemberships).toEqual([
            { team_id: phantomTeam, role: 'member', status: 'active' },
          ])
          expect(invitation).toEqual([{ status: 'pending', accepted_admin_id: null }])
          expect(newAdmins).toEqual([])
          expect(observations.filter((e: any) => e.placement === 'handover-copy-executed')).toEqual(
            []
          )
        }
      } finally {
        beforeCopyHook = undefined
        afterCopyValidationHook = undefined
        await changer.query('ROLLBACK')
        changer.release()
      }
    })
  }
}

function registerCollationTest() {
  it('COLLATE omission uses the same raw TEXT ordering as both real triggers', async () => {
    const definitions = (
      await databasePool.query(`SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
      WHERE proname IN ('authorization_bump_workflow_run_revision','authorization_bump_workflow_run_audit_revision',
        'authorization_prelock_user_retirement_revisions') ORDER BY proname`)
    ).rows
    expect(definitions).toHaveLength(3)
    for (const f of definitions) {
      expect(f.definition).not.toMatch(/COLLATE\s+"/i)
      expect(f.definition).toContain(
        f.proname === 'authorization_prelock_user_retirement_revisions'
          ? 'array_agg(subject_id ORDER BY subject_id)'
          : 'ORDER BY subject_type, subject_id'
      )
    }
    const ordering = (
      await databasePool.query(`WITH keys(subject_type,subject_id) AS (VALUES
      ('team'::text,'aaaaaaaa-0000-4000-8000-000000000001'::text),
      ('team','BBBBBBBB-0000-4000-8000-000000000002'),
      ('team','bbbbbbbb-0000-4000-8000-000000000002'),
      ('team','00000000-0000-4000-8000-000000000000'))
      SELECT array_agg(subject_id ORDER BY subject_id) AS prelock,
             array_agg(subject_id ORDER BY subject_type,subject_id) AS triggers,
             array_agg(DISTINCT pg_collation_for(subject_id)::text) AS collations FROM keys`)
    ).rows[0]
    expect(ordering.prelock).toEqual(ordering.triggers)
    expect(ordering.collations).toEqual(['"default"'])
    const db = (
      await databasePool.query(
        'SELECT datcollate,datctype,datlocprovider FROM pg_database WHERE datname=current_database()'
      )
    ).rows[0]
    save('collation-witness', {
      decision: 'omit COLLATE to match unchanged triggers',
      db,
      ordering,
      definitions,
      limitation:
        'Local PG16 ordering witness only; no live-cluster locale probe or normalization claim.',
    })
  })
}
