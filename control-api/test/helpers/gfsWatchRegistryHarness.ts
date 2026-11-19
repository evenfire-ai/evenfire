import { createPublicKey, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import { ok, toResponse } from '../../../gfs-controller/src/api/envelope.js'
import { GfsError } from '../../../gfs-controller/src/api/errors.js'
import { statResource } from '../../../gfs-controller/src/api/read.js'
import { loadVerificationKey } from '../../../gfs-controller/src/auth/keys.js'
import { verifyGfsToken } from '../../../gfs-controller/src/auth/verify.js'
import { PgResourceStore } from '../../../gfs-controller/src/db/resourceStore.js'
import type { GfsKey, Rid32, Uuid } from '../../src/services/gfsWatch/keys.js'
import { LISTENER_CLIENT_OPTIONS } from '../../src/services/gfsWatch/listener.js'
import type {
  GfsWatchRegistry,
  GfsWatchRegistryDeps,
  WatchConnection,
  WatchOpenOutcome,
  WatchSocket,
} from '../../src/services/gfsWatch/registry.js'
import {
  type VirtualWatchClock,
  createVirtualWatchClock,
  flushMicrotasks,
} from './gfsWatchClock.js'
import { previousCoreConnectionString, registryTestDatabase } from './gfsWatchRegistryEnv.js'
import { endPoolAndWaitForClients } from './realPostgresTeardown.js'

// Shared real stack for the GFS watch registry tests:
// - a fresh database migrated by the real initDb, so gfs_resources carries the
//   real gfs_resource_changed trigger and every NOTIFY comes from it;
// - V1 sessions issued and authenticated by the production producers;
// - read tokens minted by the real mint, revalidated against the database;
// - the real readGfsc against a stand-in gfsc that verifies the token with
//   gfsc's own verifier and answers with gfsc's own envelope (`ok`,
//   `toResponse`) over `statResource` on gfsc's PgResourceStore. Only the
//   authorization decision per resource is the test's: that is what the
//   model controls.
//
// Watch timers run on a virtual clock that moves only when a test advances
// it; Postgres, HTTP and the LISTEN client do real I/O.

export type GfscDecision = 'allow' | 'deny' | 'principal_denied' | 'unavailable' | 'hang'

export type GfscRead = {
  seq: number
  rid32: string
  requestId: string
  decision: GfscDecision
  status: number
}

let evCounter = 0
/** One counter across gfsc reads, frames and test writes, to order them in a model. */
export const nextEv = () => ++evCounter

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Real milliseconds a LISTEN attempt may take before the listener itself
 * gives up on it. The registry clock is virtual and stands still while a test
 * waits, so the listener's own connect deadline never fires here: only pg's
 * connect and query timeouts, which run on wall time, bound the attempt.
 */
export const LISTEN_ATTEMPT_REAL_MS =
  LISTENER_CLIENT_OPTIONS.connectionTimeoutMillis + LISTENER_CLIENT_OPTIONS.query_timeout + 1_000

/** Waits, on wall time, as long as one LISTEN attempt may legitimately take. */
export async function waitForListenerReady(ready: () => boolean): Promise<boolean> {
  const start = Date.now()
  while (!ready() && Date.now() - start < LISTEN_ATTEMPT_REAL_MS) await sleep(5)
  return ready()
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

const toRid = (uuid: string) => uuid.replaceAll('-', '') as Rid32

/**
 * A response stand-in that records every frame and checks, at the instant of
 * each write, the registry invariants that are about the socket: nothing but
 * the head and `ready` before `phase = 'ready'`, nothing after
 * `stream.closing`, and `changed` only with keys accepted outside the op.
 */
export class FakeSocket implements WatchSocket {
  headersSent = false
  status: number | null = null
  writableLength = 0
  writeReturns = true
  frames: Record<string, unknown>[] = []
  ended = 0
  violations: string[] = []
  conn: WatchConnection | null = null
  /** Event number of the admission (the open's synchronous part), or null before it. */
  admittedEv: number | null = null
  /**
   * Registry clock at the admission, where the open op starts. The open is
   * admitted only after its session authenticates, so this can be well after
   * the instant the test called open.
   */
  admittedVt: number | null = null
  onFrame: ((frame: Record<string, unknown>, ev: number) => void) | null = null
  private gone: (() => void)[] = []
  private drains: (() => void)[] = []

  constructor(private readonly listenerReady: () => boolean) {}

  writeHead(status: number): unknown {
    if (this.headersSent) this.violations.push('writeHead twice')
    this.headersSent = true
    this.status = status
    return this
  }
  flushHeaders(): unknown {
    return undefined
  }
  write(chunk: string): boolean {
    const frame = JSON.parse(chunk) as Record<string, unknown>
    const conn = this.conn
    if (this.ended > 0) this.violations.push(`write after end: ${String(frame.type)}`)
    if (frame.schemaVersion !== 1) this.violations.push('frame without schemaVersion 1')
    if (this.frames.some(f => f.type === 'stream.closing')) {
      this.violations.push(`${String(frame.type)} after stream.closing`)
    }
    if (frame.type === 'ready') {
      if (!this.headersSent) this.violations.push('ready before head')
      if (conn && conn.phase !== 'opening') this.violations.push('ready outside opening')
      if (!this.listenerReady()) this.violations.push('ready while the listener is down')
    } else if (conn && conn.phase !== 'ready') {
      this.violations.push(`${String(frame.type)} written in phase ${conn.phase}`)
    }
    if (frame.type === 'changed' && conn) {
      for (const k of frame.keys as GfsKey[]) {
        if (conn.keys.get(k)?.state !== 'accepted')
          this.violations.push(`changed for non-accepted ${k}`)
        if (conn.op?.added.has(k)) this.violations.push(`changed for in-flight ${k}`)
      }
    }
    if (this.writableLength + Buffer.byteLength(chunk) > 64 * 1024) {
      this.violations.push('buffer above 64 KB')
    }
    this.frames.push(frame)
    this.onFrame?.(frame, nextEv())
    return this.writeReturns
  }
  end(): unknown {
    this.ended += 1
    return this
  }
  once(_event: 'drain', listener: () => void): unknown {
    this.drains.push(listener)
    return this
  }
  onGone(listener: () => void): unknown {
    this.gone.push(listener)
    return this
  }
  emitGone(): void {
    for (const f of this.gone.splice(0)) f()
  }
  emitDrain(): void {
    this.writableLength = 0
    for (const f of this.drains.splice(0)) f()
  }
  framesOf(type: string): Record<string, unknown>[] {
    return this.frames.filter(f => f.type === type)
  }
  last(type: string): Record<string, unknown> | undefined {
    return this.framesOf(type).at(-1)
  }
}

type Waiter = { release: () => void; fail: (err: Error) => void; label: string }

/**
 * A pause point in front of one boundary call. `pass` lets calls through,
 * `hold` parks them until released, `fail` rejects them, and `hook` lets a
 * fast-check scheduler decide the order. A parked read is released by its
 * abort signal, as a real fetch would be.
 */
export class Gate {
  mode: 'pass' | 'hold' | 'fail' = 'pass'
  failWith: () => Error = () => new Error('gate failure')
  hook: ((label: string) => Promise<void>) | null = null
  held: Waiter[] = []
  calls = 0
  /** Calls whose boundary step settled (resolved or rejected) after passing the gate. */
  done = 0

  async pass(label: string, signal?: AbortSignal): Promise<void> {
    this.calls += 1
    if (this.hook) await this.hook(label)
    if (this.mode === 'fail') throw this.failWith()
    if (this.mode === 'pass') return
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { release: resolve, fail: reject, label }
      this.held.push(w)
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.held.indexOf(w)
          if (i >= 0) this.held.splice(i, 1)
          resolve()
        },
        { once: true }
      )
    })
  }
  releaseAll(): void {
    for (const w of this.held.splice(0)) w.release()
  }
  releaseOne(): void {
    this.held.shift()?.release()
  }
  releaseWhere(label: string): void {
    const i = this.held.findIndex(w => w.label === label)
    if (i >= 0) this.held.splice(i, 1)[0]!.release()
  }
  failAll(err = new Error('gate failure')): void {
    for (const w of this.held.splice(0)) w.fail(err)
  }
}

type AuthenticatedSession = Parameters<GfsWatchRegistry['open']>[0]['authentication']

export type TestUser = {
  userId: Uuid
  /** The team whose membership the session was issued under. */
  teamId: string
  token: string
  authenticate(): Promise<AuthenticatedSession>
}

export type BuiltRegistry = {
  registry: GfsWatchRegistry
  clock: VirtualWatchClock
  gates: {
    cte: Gate
    read: Gate
    mint: Gate
    observe: Gate
    expansion: Gate
    /** The roots window's grantee query. */
    roots: Gate
    /** The session confirmation query. */
    session: Gate
  }
  open(
    user: TestUser,
    keys: Iterable<GfsKey>,
    opts?: { requestId?: string; srvDeadlineMs?: number; watchSignal?: AbortSignal }
  ): { socket: FakeSocket; outcome: Promise<WatchOpenOutcome>; settled: () => boolean }
  /**
   * `count` opens of one authenticated session issued in the same tick, with
   * no await between them, so admission sees them back to back.
   */
  openBurst(
    user: TestUser,
    count: number
  ): Promise<{ socket: FakeSocket; outcome: Promise<WatchOpenOutcome> }[]>
  /** Connection that owns `socket`, once admitted. */
  connOf(socket: FakeSocket): WatchConnection | undefined
  settle(predicate?: () => boolean, timeoutMs?: number): Promise<void>
  /**
   * Moves the virtual clock in steps of at most 4 s, letting real I/O run in
   * between, so the listener's ping is echoed back before the echo check:
   * one jump past 20 s would declare the listener lost.
   */
  advance(ms: number): Promise<void>
  violations(): string[]
  stop(): Promise<void>
}

/**
 * The suite owns the database: it creates `registryTestDatabase` before
 * calling this and terminates and drops it after `teardown`.
 */
export async function createRegistryHarness(adminUrl: string) {
  const database = registryTestDatabase
  const connectionString = databaseUrl(adminUrl, database)
  if (process.env.CONTROL_API_PG_CONNECTION_STRING !== connectionString) {
    throw new Error('import ./helpers/gfsWatchRegistryEnv.js first in the test file')
  }
  const previousEnv = previousCoreConnectionString

  const dbModule = await import('../../src/db.js')
  const corePool = dbModule.pool as unknown as Pool
  const limiterPool = dbModule.rateLimitPool as unknown as Pool
  corePool.on('error', () => {})
  limiterPool.on('error', () => {})
  const migrationPool = new Pool({ connectionString })
  await dbModule.initDb({ connect: () => migrationPool.connect() })
  await endPoolAndWaitForClients(migrationPool)

  const configModule = await import('../../src/config.js')
  const registryModule = await import('../../src/services/gfsWatch/registry.js')
  const watchPoolModule = await import('../../src/services/gfsWatch/watchPool.js')
  const readModule = await import('../../src/gfs/externalGfsRead.js')
  const authnModule = await import('../../src/services/auth/externalSessionAuthentication.js')
  const issuance = await import('../../src/services/auth/externalSessionIssuance.js')
  const userSessions = await import('../../src/services/auth/userSessionService.js')
  const schemas = await import('../../src/services/gfsWatch/notifySchemas.js')
  const metrics = await import('../../src/observability/metrics.js')

  const writer = new Pool({ connectionString, max: 4 })
  writer.on('error', () => {})

  // ─── gfsc stand-in ───────────────────────────────────────────────────────
  const publicKey = String(
    createPublicKey(configModule.config.rpcJwtPrivateKey).export({ type: 'spki', format: 'pem' })
  )
  const verificationKey = loadVerificationKey(publicKey)
  const store = new PgResourceStore(corePool as never)
  const decisions = new Map<string, GfscDecision>()
  const reads: GfscRead[] = []
  const hanging = new Set<ServerResponse>()
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const m = /^\/v1\/resources\/([^/?]+)$/.exec(req.url ?? '')
      if (!m) return send(res, 404, toResponse(new GfsError('not_found', 'route')).body)
      const rid32 = decodeURIComponent(m[1]!).replaceAll('-', '').toLowerCase()
      const requestId = String(req.headers['x-request-id'] ?? '')
      let claims: { drive: string } | null = null
      try {
        const auth = String(req.headers.authorization ?? '')
        claims = verifyGfsToken(auth.replace(/^Bearer /, ''), {
          key: verificationKey,
          audience: configModule.config.gfsTokenAudience,
          issuer: configModule.config.rpcJwtIssuer,
        }) as unknown as { drive: string }
      } catch {
        claims = null
      }
      const decision = decisions.get(rid32) ?? 'allow'
      const record = (status: number) =>
        reads.push({ seq: nextEv(), rid32, requestId, decision, status })
      if (claims === null) {
        const r = toResponse(new GfsError('unauthorized', 'bad token'))
        record(r.status)
        return send(res, r.status, r.body)
      }
      if (decision === 'hang') {
        record(0)
        hanging.add(res)
        res.on('close', () => hanging.delete(res))
        return
      }
      let error: GfsError | null = null
      if (decision === 'deny') error = new GfsError('forbidden', 'not authorized to read')
      if (decision === 'principal_denied') {
        error = new GfsError('forbidden', 'principal is not authorized', 'principal_denied')
      }
      if (decision === 'unavailable') error = new GfsError('not_mounted', 'store down')
      if (error) {
        const r = toResponse(error)
        record(r.status)
        return send(res, r.status, r.body)
      }
      try {
        const view = await statResource(store, claims.drive, rid32)
        record(200)
        send(res, 200, ok(view))
      } catch (err) {
        const r = toResponse(err)
        record(r.status)
        send(res, r.status, r.body)
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  configModule.config.gfscBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ─── Fixtures through real writers ───────────────────────────────────────
  const rootId = randomUUID()
  await writer.query(
    `INSERT INTO gfs_resources (resource_id, drive, name, kind, path_cache)
     VALUES ($1, 'main', 'root', 'directory', '/')`,
    [rootId]
  )
  let nameSeq = 0
  const tree = {
    root: rootId,
    async add(kind: 'file' | 'directory', parent: string = rootId): Promise<string> {
      const id = randomUUID()
      nameSeq += 1
      await writer.query(
        `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, 'main', $2, $3, $4, NULL)`,
        [id, parent, `n${nameSeq}`, kind]
      )
      return id
    },
    async move(id: string, parent: string): Promise<void> {
      await writer.query(
        `UPDATE gfs_resources SET parent_resource_id = $2 WHERE resource_id = $1`,
        [id, parent]
      )
    },
    async rename(id: string): Promise<void> {
      nameSeq += 1
      await writer.query(`UPDATE gfs_resources SET name = $2 WHERE resource_id = $1`, [
        id,
        `r${nameSeq}`,
      ])
    },
    async softDelete(id: string): Promise<void> {
      await writer.query(`UPDATE gfs_resources SET deleted_at = now() WHERE resource_id = $1`, [id])
    },
  }
  const key = (kind: 'file' | 'dir', id: string) => `${kind}:gfs://main/${toRid(id)}` as GfsKey

  // Authorization writes through the production writers, so each fires the
  // real gfs_authz_changed trigger with the rows they really write: grants
  // through the grant route's batch writer as a Control UI operator,
  // memberships through the directory service. The stand-in gfsc's
  // decisions stay the test's, through `decisions`.
  const linkModule = await import('../../src/services/gfsDesktopOperatorLinkService.js')
  const adminAuthModule = await import('../../src/services/adminAuthService.js')
  const grantsModule = await import('../../src/routes/gfs/grants.js')
  const membershipModule = await import('../../src/services/directory/membership.js')
  const sharesModule = await import('../../src/routes/gfs/shares.js')
  const usersModule = await import('../../src/services/directory/users.js')
  const passwordModule = await import('../../src/services/directory/memberPassword.js')
  const operatorAdminId = (
    await writer.query<{ id: string }>(
      `INSERT INTO control_admin_users (username, password_hash)
       VALUES ($1, 'x') RETURNING id::text AS id`,
      [`gfs-watch-operator-${randomUUID()}`]
    )
  ).rows[0]!.id
  const operatorReq = {
    adminAuth: { sub: operatorAdminId },
    ip: '127.0.0.1',
    gfsRequestId: randomUUID(),
  } as unknown as import('express').Request
  const operatorCaller = grantsModule.resolveCaller(operatorReq)
  type SubjectType = 'user' | 'team' | 'operator' | 'host' | 'context'
  async function writeGrant(
    db: import('../../src/db.js').DbClient,
    resourceId: string,
    subjectType: SubjectType,
    subjectId: string,
    permissions: string[]
  ): Promise<string> {
    const subject =
      subjectType === 'operator' ? { type: subjectType } : { type: subjectType, id: subjectId }
    const { error } = await grantsModule.writeGfsGrantBatchInTransaction(db, {
      req: operatorReq,
      caller: operatorCaller,
      drive: 'main',
      resourceId,
      subjects: [subject],
      permissions: permissions as import('../../src/routes/gfs/grants.js').GfsPermission[],
      inherit: true,
    })
    if (error) throw error
    const row = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM gfs_grants
        WHERE drive = 'main' AND resource_id = $1 AND subject_type = $2 AND subject_id = $3`,
      [resourceId, subjectType, subjectType === 'operator' ? '' : subjectId]
    )
    return row.rows[0]!.id
  }
  const authz = {
    async grant(
      resourceId: string,
      subjectType: SubjectType,
      subjectId: string,
      permissions: string[] = ['read']
    ): Promise<string> {
      return dbModule.withTransaction(db =>
        writeGrant(db, resourceId, subjectType, subjectId, permissions)
      )
    },
    /** One transaction, one grant per resource: Postgres folds identical payloads. */
    async grantMany(resourceIds: string[], subjectType: 'user' | 'team', subjectId: string) {
      await dbModule.withTransaction(async db => {
        for (const r of resourceIds) await writeGrant(db, r, subjectType, subjectId, ['read'])
      })
    },
    /** A share through the share route's batch writer. */
    async share(
      resourceId: string,
      subjectType: SubjectType,
      subjectId: string,
      permissions: string[] = ['read']
    ): Promise<void> {
      await dbModule.withTransaction(async db => {
        const { error } = await sharesModule.writeGfsShareBatchInTransaction(db, {
          req: operatorReq,
          caller: operatorCaller,
          drive: 'main',
          resourceId,
          subjects: [
            subjectType === 'operator'
              ? { type: subjectType }
              : { type: subjectType, id: subjectId },
          ],
          permissions: permissions as import('../../src/routes/gfs/grants.js').GfsPermission[],
          includeDescendants: true,
        })
        if (error) throw error
      })
    },
    /**
     * The statement the grant route's DELETE runs; that handler is not
     * exported and needs an authenticated Control UI request around it.
     */
    async revoke(grantId: string): Promise<void> {
      await writer.query(`DELETE FROM gfs_grants WHERE id = $1::uuid`, [grantId])
    },
    async createTeam(): Promise<string> {
      const r = await writer.query<{ id: string }>(
        `INSERT INTO teams (name) VALUES ('gfs-watch-authz') RETURNING id::text AS id`
      )
      return r.rows[0]!.id
    },
    async join(teamId: string, userId: string): Promise<void> {
      await membershipModule.addMemberToTeam(teamId, userId, operatorAdminId)
    },
    async leave(teamId: string, userId: string): Promise<void> {
      await membershipModule.softDeleteMember(teamId, userId, operatorAdminId)
    },
    async createAdmin(): Promise<string> {
      const r = await writer.query<{ id: string }>(
        `INSERT INTO control_admin_users (username, password_hash)
         VALUES ($1, 'x') RETURNING id::text AS id`,
        [`gfs-watch-${randomUUID()}`]
      )
      return r.rows[0]!.id
    },
    async link(userId: string, adminId: string): Promise<void> {
      await linkModule.gfsDesktopOperatorLinkService.link({
        desktopUserId: userId,
        controlAdminId: adminId,
        source: 'initial_setup',
        operatorSub: adminId,
        requestId: `gfs-watch-${randomUUID()}`,
      })
    },
    async unlink(userId: string, adminId: string): Promise<void> {
      await linkModule.gfsDesktopOperatorLinkService.unlink({
        desktopUserId: userId,
        controlAdminId: adminId,
        operatorSub: adminId,
        reason: 'gfs watch test',
        requestId: `gfs-watch-${randomUUID()}`,
      })
    },
    /** The real password writer: bumps the admin's session_version. */
    async bumpAdmin(adminId: string): Promise<void> {
      await adminAuthModule.updateAdminPassword(adminId, `x-${randomUUID()}`)
    },
  }

  // Every lifecycle write goes through its production writer, so the users
  // triggers emit exactly the session hints those writers cause.
  const retirementActor = randomUUID()
  await writer.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'gfs-watch-actor')`, [
    retirementActor,
    `${retirementActor}@example.test`,
  ])
  const lifecycle = {
    /** Retired with operator-link history, physically deleted without it. */
    async retire(userId: string) {
      return dbModule.withTransaction(db =>
        usersModule.retireDesktopUser(
          { kind: 'platform_user', desktopUserId: retirementActor },
          userId,
          'gfs watch test',
          `gfs-watch-${randomUUID()}`,
          `gfs-watch-${randomUUID()}`,
          { db }
        )
      )
    },
    /**
     * The member's own password change. The current password is put in place
     * first with a plain hash update, which does not touch lifecycle_* and so
     * emits nothing.
     */
    async changePassword(userId: string): Promise<void> {
      const current = `pw-${randomUUID()}`
      const bcrypt = (await import('bcryptjs')).default
      await writer.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
        userId,
        await bcrypt.hash(current, 4),
      ])
      const r = await passwordModule.updateUserPassword(
        userId,
        `${userId}@example.test`,
        current,
        `pw-${randomUUID()}`
      )
      if (!('updated' in r)) throw new Error(`password change failed: ${JSON.stringify(r)}`)
    },
    async revokeAll(userId: string): Promise<void> {
      await dbModule.withTransaction(db =>
        userSessions.revokeAllUserSessions(userId, 'gfs-watch-test', db)
      )
    },
    async version(userId: string): Promise<{ state: string; version: number } | null> {
      const r = await writer.query<{ s: string; v: string }>(
        `SELECT lifecycle_state AS s, lifecycle_version::text AS v FROM users WHERE id = $1`,
        [userId]
      )
      const row = r.rows[0]
      return row ? { state: row.s, version: Number(row.v) } : null
    },
  }

  const policy = {
    issueV1: true,
    acceptV1: true,
    issueV2: false,
    acceptV2: false,
  } as import('../../src/services/access/userAccessPolicy.js').EffectiveUserAccessPolicy

  async function createUser(): Promise<TestUser> {
    const userId = randomUUID() as Uuid
    const teamId = randomUUID()
    await writer.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, 'gfs-watch-registry')`,
      [userId, `${userId}@example.test`]
    )
    await writer.query(`INSERT INTO teams (id, name) VALUES ($1, 'gfs-watch-registry-team')`, [
      teamId,
    ])
    await writer.query(
      `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    await dbModule.withTransaction(db =>
      userSessions.revokeAllUserSessions(userId, 'gfs-watch-registry-fixture', db)
    )
    return issueSession(userId, teamId)
  }

  /** A V1 session for the user's current authorization generation. */
  async function issueSession(userId: Uuid, teamId: string): Promise<TestUser> {
    const token = (
      await issuance.issueExternalUserSession(
        {
          contract: 'v1',
          userId,
          email: `${userId}@example.test`,
          teamId,
          role: 'member',
          authenticationMethods: ['pwd'],
        },
        { policy }
      )
    ).token
    return {
      userId,
      teamId,
      token,
      async authenticate() {
        const a = await authnModule.authenticateExternalUserSession(token, { purpose: 'protected' })
        if (a.status !== 'authenticated')
          throw new Error(`session did not authenticate: ${a.status}`)
        return a as AuthenticatedSession
      },
    }
  }

  /** The same user, signed in again after a lifecycle write moved its generation. */
  const reissue = (user: TestUser) => issueSession(user.userId, user.teamId)

  async function invalidCount(channel: string): Promise<number> {
    const { values } = await metrics.gfsWatchNotifyInvalidTotal.get()
    return values.filter(v => v.labels.channel === channel).reduce((a, v) => a + v.value, 0)
  }

  /**
   * NOTIFYs reach a listener in commit order, so once an invalid ping sent
   * after a write has been counted, every NOTIFY of that write was dispatched.
   */
  async function barrier(): Promise<void> {
    const before = await invalidCount('gfs_watch_ping')
    await writer.query(`SELECT pg_notify('gfs_watch_ping', 'barrier')`)
    for (let i = 0; i < 500; i += 1) {
      if ((await invalidCount('gfs_watch_ping')) > before) return
      await sleep(2)
    }
    throw new Error('NOTIFY barrier not delivered')
  }

  /**
   * Terminates the registry's LISTEN backend; returns how many backends it
   * ended. pg_stat_activity shows a backend's last statement: the listener's
   * is its LISTEN until its first ping, then the parameterized ping. The
   * barrier's ping is a literal, so it never matches.
   */
  async function terminateListener(): Promise<number> {
    const r = await writer.query<{ n: number }>(
      `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND (query LIKE 'LISTEN gfs_resource_changed%'
               OR query = 'SELECT pg_notify(''gfs_watch_ping'', $1)')`
    )
    return r.rows[0]!.n
  }

  async function notifyCmd(cmd: Parameters<typeof schemas.serializeWatchCmd>[0]): Promise<void> {
    await writer.query('SELECT pg_notify($1, $2)', [
      schemas.GFS_WATCH_CMD_CHANNEL,
      schemas.serializeWatchCmd(cmd),
    ])
    await barrier()
  }

  const built: BuiltRegistry[] = []

  async function build(
    overrides: Partial<GfsWatchRegistryDeps> & { permits?: number } = {}
  ): Promise<BuiltRegistry> {
    const clock = createVirtualWatchClock({ random: () => 0.5 })
    const gates = {
      cte: new Gate(),
      read: new Gate(),
      mint: new Gate(),
      observe: new Gate(),
      expansion: new Gate(),
      roots: new Gate(),
      session: new Gate(),
    }
    // Optional real latency on the window queries, to show a rest predicate
    // that does not wait for them is not one.
    const sessionLatencyMs = Number(process.env.GFS_WATCH_TEST_SESSION_LATENCY_MS ?? 0)
    const windowGates = new Map<unknown, [Gate, string, number]>([
      [registryModule.GFS_WATCH_ROOTS_GRANTEES_SQL, [gates.roots, 'roots', sessionLatencyMs]],
      [registryModule.GFS_WATCH_SESSION_CONFIRM_SQL, [gates.session, 'session', sessionLatencyMs]],
    ])
    const expansionLatencyMs = Number(process.env.GFS_WATCH_TEST_EXPANSION_LATENCY_MS ?? 0)
    const expansionTexts: unknown[] = [
      registryModule.GFS_WATCH_EXPAND_TEAMS_SQL,
      registryModule.GFS_WATCH_EXPAND_ADMINS_SQL,
    ]
    const watchPool = watchPoolModule.createGfsWatchPool(connectionString)
    const gatedPool = {
      query: (async (config: unknown, ...rest: unknown[]) => {
        if (
          typeof config === 'object' &&
          config !== null &&
          (config as { text?: unknown }).text === registryModule.GFS_WATCH_ANCESTRY_CTE
        ) {
          await gates.cte.pass('cte')
        } else if (
          typeof config === 'object' &&
          config !== null &&
          expansionTexts.includes((config as { text?: unknown }).text)
        ) {
          try {
            await gates.expansion.pass('expansion')
            // Optional real latency on the expansion, to show a rest predicate
            // that does not wait for it is not one.
            if (expansionLatencyMs > 0) await sleep(expansionLatencyMs)
            return await (watchPool.query as (...a: unknown[]) => Promise<unknown>)(config, ...rest)
          } finally {
            gates.expansion.done += 1
          }
        } else if (
          typeof config === 'object' &&
          config !== null &&
          windowGates.has((config as { text?: unknown }).text)
        ) {
          const [gate, label, latency] = windowGates.get((config as { text?: unknown }).text)!
          try {
            await gate.pass(label)
            if (latency > 0) await sleep(latency)
            return await (watchPool.query as (...a: unknown[]) => Promise<unknown>)(config, ...rest)
          } finally {
            gate.done += 1
          }
        } else {
          await gates.observe.pass('observe')
        }
        return (watchPool.query as (...a: unknown[]) => Promise<unknown>)(config, ...rest)
      }) as unknown as Pool['query'],
    }
    let registry!: GfsWatchRegistry
    registry = registryModule.createGfsWatchRegistry({
      listenConnectionString: connectionString,
      watchPool: gatedPool,
      clock,
      mintReadToken: async (...args) => {
        await gates.mint.pass('mint')
        return readModule.mintExternalGfsReadToken(...args)
      },
      readGfsc: async (rid32, token, opId, signal, timeout) => {
        await gates.read.pass(`read:${rid32}`, signal)
        return readModule.readGfsc(rid32, token, opId, signal, timeout)
      },
      ...overrides,
    })
    const sockets: FakeSocket[] = []
    const opening = new Set<Promise<unknown>>()
    registry.start()
    const b: BuiltRegistry = {
      registry,
      clock,
      gates,
      open(user, keys, opts = {}) {
        const socket = new FakeSocket(() => registry.listenerReady())
        sockets.push(socket)
        let done = false
        const outcome = (async () => {
          const authentication = await user.authenticate()
          const before = new Set(registry.state.byConnId.values())
          const p = registry.open({
            authentication,
            keys: new Set(keys),
            socket,
            srvDeadline: registry.now() + (opts.srvDeadlineMs ?? 12_000),
            watchSignal: opts.watchSignal ?? new AbortController().signal,
            requestId: opts.requestId ?? randomUUID(),
          })
          for (const c of registry.state.byConnId.values()) if (!before.has(c)) socket.conn = c
          if (socket.conn) {
            socket.admittedEv = nextEv()
            socket.admittedVt = registry.now()
          }
          return p
        })().finally(() => {
          done = true
        })
        opening.add(outcome)
        void outcome.finally(() => opening.delete(outcome))
        return { socket, outcome, settled: () => done }
      },
      async openBurst(user, count) {
        const authentication = await user.authenticate()
        const out: { socket: FakeSocket; outcome: Promise<WatchOpenOutcome> }[] = []
        for (let i = 0; i < count; i += 1) {
          const socket = new FakeSocket(() => registry.listenerReady())
          sockets.push(socket)
          const before = new Set(registry.state.byConnId.values())
          const outcome = registry.open({
            authentication,
            keys: new Set(),
            socket,
            srvDeadline: registry.now() + 12_000,
            watchSignal: new AbortController().signal,
            requestId: randomUUID(),
          })
          for (const c of registry.state.byConnId.values()) if (!before.has(c)) socket.conn = c
          if (socket.conn) socket.admittedVt = registry.now()
          opening.add(outcome)
          void outcome.finally(() => opening.delete(outcome))
          out.push({ socket, outcome })
        }
        return out
      },
      connOf(socket) {
        return socket.conn ?? undefined
      },
      async settle(predicate, timeoutMs = 5_000) {
        // An expansion, grantee query or session confirmation still in flight
        // resumes into closes or frames, so the registry is not at rest until
        // each has settled.
        const quiet =
          predicate ??
          (() =>
            registry.state.opsInFlight.size === 0 &&
            opening.size === 0 &&
            gates.expansion.calls === gates.expansion.done &&
            gates.roots.calls === gates.roots.done &&
            gates.session.calls === gates.session.done)
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          await flushMicrotasks()
          if (quiet()) {
            await sleep(5)
            await flushMicrotasks()
            if (quiet()) return
          }
          await sleep(3)
        }
        throw new Error('registry did not settle')
      },
      violations() {
        return sockets.flatMap(s => s.violations)
      },
      async advance(ms) {
        let left = ms
        while (left > 0) {
          const step = Math.min(4_000, left)
          const echo = registry.state.listener.lastEchoAt
          const pingsBefore = registry.state.listener.pingCounter
          clock.advance(step)
          left -= step
          await flushMicrotasks()
          if (registry.state.listener.pingCounter !== pingsBefore && registry.listenerReady()) {
            for (let i = 0; i < 200 && registry.state.listener.lastEchoAt === echo; i += 1) {
              await sleep(2)
            }
          }
        }
      },
      async stop() {
        registry.stop()
        for (const g of Object.values(gates)) {
          g.mode = 'pass'
          g.hook = null
          g.releaseAll()
        }
        await Promise.allSettled([...opening])
        await endPoolAndWaitForClients(watchPool)
      },
    }
    built.push(b)
    if (!(await waitForListenerReady(() => registry.listenerReady()))) {
      throw new Error('listener did not become ready')
    }
    return b
  }

  async function teardown(): Promise<void> {
    for (const b of built.splice(0)) await b.stop().catch(() => {})
    for (const res of hanging) res.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await endPoolAndWaitForClients(writer)
    await endPoolAndWaitForClients(corePool)
    await endPoolAndWaitForClients(limiterPool)
    if (previousEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
    else process.env.CONTROL_API_PG_CONNECTION_STRING = previousEnv
  }

  return {
    connectionString,
    writer,
    corePool,
    tree,
    authz,
    lifecycle,
    key,
    toRid,
    createUser,
    reissue,
    barrier,
    terminateListener,
    notifyCmd,
    invalidCount,
    decisions,
    reads,
    releaseHanging() {
      for (const res of hanging) res.destroy()
    },
    build,
    teardown,
    modules: { registry: registryModule, schemas, metrics, read: readModule, config: configModule },
  }
}

export type RegistryHarness = Awaited<ReturnType<typeof createRegistryHarness>>

/** I23, I24, I25, I38 and I42 on a registry at rest. */
export function restInvariantViolations(
  b: BuiltRegistry,
  closed: WatchConnection[] = []
): string[] {
  const v: string[] = []
  const st = b.registry.state
  if (st.opsInFlight.size > 0) v.push(`I24: ${st.opsInFlight.size} ops in flight`)
  const expectedRes = new Map<string, Set<WatchConnection>>()
  const expectedAnc = new Map<string, Set<WatchConnection>>()
  for (const conn of st.byConnId.values()) {
    if (conn.op !== null) v.push(`I24: ${conn.connId} has an op`)
    if (conn.phase === 'closed') v.push(`I23: closed ${conn.connId} still admitted`)
    for (const [k, r] of conn.keys) {
      if (conn.phase === 'ready' && r.state === 'authorizing') v.push(`I25: ${k} authorizing`)
      if (r.state === 'rejected' && r.chain !== null) v.push(`I23: rejected ${k} indexed`)
      if (r.state === 'accepted' && r.chain === null) v.push(`I23: accepted ${k} not indexed`)
      if (r.chain === null) continue
      const rr = k.slice(k.lastIndexOf('/') + 1)
      ;(expectedRes.get(rr) ?? expectedRes.set(rr, new Set()).get(rr)!).add(conn)
      for (const a of r.chain)
        (expectedAnc.get(a) ?? expectedAnc.set(a, new Set()).get(a)!).add(conn)
    }
  }
  const sameIndex = (
    name: string,
    actual: ReadonlyMap<string, ReadonlySet<WatchConnection>>,
    expected: Map<string, Set<WatchConnection>>
  ) => {
    for (const [x, set] of actual) {
      if (set.size === 0) v.push(`${name}: empty entry ${x}`)
      for (const c of set)
        if (!expected.get(x)?.has(c)) v.push(`I23: ${name}[${x}] holds ${c.connId}`)
    }
    for (const [x, set] of expected)
      for (const c of set)
        if (!actual.get(x)?.has(c)) v.push(`I23: ${name}[${x}] misses ${c.connId}`)
  }
  sameIndex('byResource', st.byResource, expectedRes)
  sameIndex('byAncestor', st.byAncestor, expectedAnc)
  for (const conn of closed) {
    if (st.byConnId.get(conn.connId) === conn) v.push(`I23: closed ${conn.connId} in byConnId`)
    for (const set of [
      ...st.byResource.values(),
      ...st.byAncestor.values(),
      ...st.byUser.values(),
    ]) {
      if (set.has(conn)) v.push(`I23: closed ${conn.connId} still indexed`)
    }
    for (const [name, h] of Object.entries(conn.timers)) {
      if (h !== null) v.push(`I38: closed ${conn.connId} timer ${name}`)
    }
  }
  if (st.readSlots.free !== 64) v.push(`I42: free = ${st.readSlots.free}`)
  if (st.readSlots.waiters !== 0) v.push(`I42: waiters = ${st.readSlots.waiters}`)
  if (st.readSlots.demand !== 0) v.push(`I42: demand = ${st.readSlots.demand}`)
  return v
}

export const uuid = () => randomUUID() as Uuid
