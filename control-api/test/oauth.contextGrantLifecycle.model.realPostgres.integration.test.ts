/**
 * Model-based check of the `context` (shared) OAuth grant lifecycle: random
 * sequences of consent mints and callbacks, Context writes through the admin
 * routes and from writers outside control-api, membership changes, Host moves,
 * disconnects, sweeps, refreshes and broker reads. Every await of the code under
 * test that touches shared state is a point the fast-check scheduler orders, so
 * each run explores one interleaving of the commands launched concurrently.
 *
 * Layers:
 *   - Postgres is real. Every `pool.query` of the code under test waits on the
 *     scheduler before it runs, then runs alone and in release order, so the
 *     order the scheduler picked is the order Postgres saw. Transactions are not
 *     gated: one that waited on the scheduler while holding row locks could
 *     deadlock against Postgres. Only their BEGIN joins the release order,
 *     because it fixes the `now()` a refresh stamps on the row.
 *   - The apiserver is the in-memory `MockGateway`; reads and writes of
 *     Contexts, Hosts, McpServers and Secrets wait on the scheduler first.
 *   - The provider token endpoint (`globalThis.fetch`) is the only network stub.
 *     Its answer waits on the scheduler: that is the gap between the access
 *     re-check and the grant insert. Every token it issues is already inside the
 *     broker's refresh window, so every broker read of a grant refreshes it.
 *   - Routes, gates, broker, hooks and the sweep are the production code, through
 *     `createApp` and the admin router. Hosts, Contexts, allowlists and
 *     memberships are written by their production writers; writers outside
 *     control-api (workflow-recipes, kubectl) are the gateway itself.
 *
 * The reference model does not decide the order: it reads it from the gates.
 * It applies each grant statement as Postgres ran it and must predict exactly
 * what the statement touched. Each request's verdict is checked against what
 * that request itself read (each condition in its own read), and at rest the
 * model is compared with `oauth_grants` and with both connector rails.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.contextGrantLifecycle.model.realPostgres.integration.test.ts
 *
 * A failure prints the command sequence, the scheduler's release order and the
 * violated invariants. `FC_SEED=<n>` replays another seed and `FC_NUM_RUNS=<n>`
 * changes the number of runs. The test also fails when the runs never reached
 * the states the invariants are about (a consent completed, a purge that
 * removed rows, a refresh, ...): passing them vacuously proves nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fc from 'fast-check'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { signOAuthState } from '../src/oauth/state.js'
import { createAdminRouter } from '../src/routes/admin/index.js'
import { setUserAgents } from '../src/services/directory/agentAccess.js'
import { setUserContexts } from '../src/services/directory/contextAccess.js'
import { runSharedGrantSweep } from '../src/services/oauthSharedGrantSweepCron.js'
import { issueRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import { seedActiveMember, seedControlAdmin } from './fixtures/contextAllowlist.js'
import { mintHccControlToken } from './fixtures/hccControlToken.js'
import { OAUTH_ID, bakedOAuth, installServer } from './fixtures/legacyOAuthGrant.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

const testDb = vi.hoisted(() => ({
  query: undefined as undefined | ((text: string, values?: unknown[]) => Promise<unknown>),
  txPool: undefined as undefined | { connect: () => Promise<unknown> },
}))

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const query = (text: string, values?: unknown[]) => {
    if (!testDb.query) throw new Error('test pool not initialised')
    return testDb.query(text, values)
  }
  const txPool = () => {
    if (!testDb.txPool) throw new Error('test pool not initialised')
    return testDb.txPool as unknown as import('pg').Pool
  }
  return {
    ...actual,
    pool: { query, connect: () => txPool().connect() },
    withTransaction: (
      work: Parameters<typeof actual.withTransaction>[0],
      _pool?: unknown,
      options?: Parameters<typeof actual.withTransaction>[2]
    ) => actual.withTransaction(work, txPool(), options),
  }
})

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const NS = config.mcpServersNamespace
// Contexts live apart from the McpServers whose namespace keys the grant rows,
// as a deployment may place them: a reader or purge that mixes the two shows.
const CTX_NS = 'oracle-contexts'
const HOSTS_NS = config.hostsNamespace
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** The context-scope server under test, and a user-scope one that must never be touched. */
const SC = 'shared-drive'
const SU = 'personal-drive'
const SERVERS = [SC, SU] as const
const CONTEXTS = ['c1', 'c2', 'c3'] as const
const HOSTS = { h1: 'c1', h2: 'c2', h3: 'c3' } as const
type HostName = keyof typeof HOSTS
const HOST_NAMES = Object.keys(HOSTS) as HostName[]
/** Inside the broker's 60 s refresh window: every broker read takes the refresh path. */
const TOKEN_TTL_SECONDS = 30
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261029
const NUM_RUNS = process.env.FC_NUM_RUNS ? Number(process.env.FC_NUM_RUNS) : 300

// ── observation records ─────────────────────────────────────────────────────

interface CtxObs {
  name: string
  found: boolean
  live: boolean
  servers: Set<string>
  uid?: string
  /** Position of the read (gets only). */
  seq?: number
}

interface HostObs {
  name: string
  found: boolean
  contextRef?: string
}

interface StatementObs {
  seq: number
  cls: StatementClass
  values: unknown[]
  failed?: boolean
  /** Rows a purge returned, as `server|context`. */
  deleted?: string[]
  /** Rows a fenced purge kept only because they were written after its clock. */
  fencedOut?: number
  /** Rows the admin create's purge removed (earlier incarnations). */
  earlierIncarnationPurged?: number
}

type ReqKind =
  | 'mint'
  | 'callback'
  | 'disconnect'
  | 'put'
  | 'delete'
  | 'post'
  | 'sweep'
  | 'broker'
  | 'external'
  | 'membership'
  | 'host'
  | 'client'

interface Claims {
  server: string
  user: string
  context?: string
  legacy: boolean
}

interface Req {
  id: string
  kind: ReqKind
  label: string
  startSeq: number
  endSeq?: number
  status?: number
  body?: unknown
  claims?: Claims
  context?: string
  ctxReads: CtxObs[]
  hostReads: HostObs[]
  ctxLists: Array<Map<string, CtxObs>>
  userContextsReads: string[][]
  userAgentsReads: string[][]
  grantReads: Array<Array<Record<string, unknown>>>
  /** Row locks the refresh took (`SELECT 1 … FOR UPDATE`): whether the row was there. */
  lockReads: boolean[]
  /** Model incarnation of the row the broker's last grant read saw. */
  /** The grant row as the model held it at the broker's last read of it. */
  servedRow?: { c5Uid?: string; insertSeq: number } | null
  statements: StatementObs[]
  idpPosts: string[]
  /** The route's own Context write: what the apiserver accepted, if it did. */
  ctxWrite?: { ok: boolean; servers?: Set<string>; seq: number; uid?: string }
  clockSeq?: number
  listSeq?: number
  listedLive?: number
  hookFailed?: boolean
  /** An admin PUT that resent a `contextId` differing from the name, as read. */
  aliasResent?: boolean
  sweepOutcome?: string
}

// ── reference model ─────────────────────────────────────────────────────────

interface Row {
  kind: 'shared' | 'user'
  server: string
  /** Context name (shared) or user id (user). */
  owner: string
  bootstrappedBy?: string
  crUid: string | null
  insertSeq: number
  /** Position of the write whose `now()` stamped `updated_at`. */
  updSeq: number
  /** uid of the Context incarnation the inserting callback validated. */
  c5Uid?: string
}

interface Incarnation {
  uid: string
  seq: number
  /** Who created it: the starting world, the admin POST, or a writer outside control-api. */
  by: 'setup' | 'admin' | 'external'
  reqId?: string
  /** The admin create's own purge of earlier incarnations: position, and whether it failed. */
  purgeSeq?: number
  purgeFailed?: boolean
}

interface ModelCtx {
  uid: string
  servers: Set<string>
  contextId?: string
}

interface Model {
  contexts: Map<string, ModelCtx>
  hosts: Map<string, string>
  userContexts: Map<string, string[]>
  userAgents: Map<string, string[]>
  rows: Map<string, Row>
  /** Text of each sweep clock read → its position. */
  clocks: Map<string, number>
  /** Every incarnation of each Context, by uid. */
  incarnations: Map<string, Incarnation>
  ctxWrites: Array<{ seq: number; name: string; reqId?: string }>
  grantWrites: Array<{ seq: number; context?: string; reqId?: string; refresh: boolean }>
  /** Shared rows removed (purge or revoke), by Context. */
  grantDeletes: Array<{ seq: number; context: string }>
  /** Membership and Host writes, as [start, end] positions of their command. */
  accessWrites: Array<{ start: number; end: number }>
}

interface MintRecord {
  state: string
  claims: Claims
}

const sharedKey = (server: string, context: string) => `shared|${server}|${context}`
const userKey = (server: string, user: string) => `user|${server}|${user}`

type StatementClass =
  | 'bootstrap'
  | 'userUpsert'
  | 'purgeExcept'
  | 'purgeMissing'
  | 'deleteShared'
  | 'clock'
  | 'readUserContexts'
  | 'readUserAgents'
  | 'readGrants'
  | 'otherGrantWrite'
  | 'other'

function classify(text: string): StatementClass {
  const sql = text.replace(/\s+/g, ' ')
  if (/INSERT INTO oauth_grants/.test(sql)) {
    if (/'shared'/.test(sql)) return 'bootstrap'
    if (/'user'/.test(sql)) return 'userUpsert'
    return 'otherGrantWrite'
  }
  if (/DELETE FROM oauth_grants/.test(sql)) {
    if (/recipe_name = ANY/.test(sql)) return 'purgeExcept'
    if (/context_id = ANY/.test(sql)) return 'purgeMissing'
    if (/context_id = \$4 AND oauth_client_id = \$5 AND grant_kind = 'shared'/.test(sql)) {
      return 'deleteShared'
    }
    return 'otherGrantWrite'
  }
  if (/UPDATE oauth_grants/.test(sql)) return 'otherGrantWrite'
  if (/SELECT now\(\)::text AS tick_start/.test(sql)) return 'clock'
  if (/FROM user_contexts/.test(sql)) return 'readUserContexts'
  if (/FROM user_agents/.test(sql) && !/team_agents/.test(sql)) return 'readUserAgents'
  if (/FROM oauth_grants/.test(sql)) return 'readGrants'
  return 'other'
}

function sqlLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 48)
}

function contextAllowlistOf(spec: unknown): Set<string> {
  const raw = (spec as { mcpServers?: unknown } | undefined)?.mcpServers
  return new Set(Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [])
}

function ctxObsFrom(name: string, cr: unknown): CtxObs {
  const res = cr as
    | { metadata?: { uid?: string; deletionTimestamp?: string }; spec?: unknown }
    | undefined
  return {
    name,
    found: true,
    live: !res?.metadata?.deletionTimestamp,
    servers: contextAllowlistOf(res?.spec),
    uid: res?.metadata?.uid,
  }
}

describeRealPostgres(
  'context-scope grant lifecycle against a reference model (real Postgres)',
  () => {
    const database = `control_api_ctx_model_${randomUUID().replace(/-/g, '')}`
    let adminPool: Pool
    let dbPool: Pool
    let rawDb: DbClient
    let operator: string
    let users: string[] = []

    const als = new AsyncLocalStorage<Req>()

    // Per-run state, reset by `startRun`.
    const H = {
      s: null as fc.Scheduler | null,
      seq: 0,
      reqCounter: 0,
      reqs: new Map<string, Req>(),
      model: undefined as unknown as Model,
      violations: [] as string[],
      failPurges: 0,
      dbTail: Promise.resolve() as Promise<unknown>,
      mints: [] as MintRecord[],
      usedStates: [] as MintRecord[],
      /** Called when a consent callback reaches the provider (its access re-check is behind it). */
      onCodeExchange: null as null | (() => void),
      /** A panel at rest showed an agent without its Context's grant while another Context held one. */
      panelMixed: false,
      /** Incarnation mismatches the checks had to judge in this run. */
      incarnationJudged: 0,
      /** Requests a sequential command left in flight; settled before the run rests. */
      background: [] as Promise<void>[],
      gateway: undefined as unknown as MockGateway,
      gated: undefined as unknown as MockGateway,
      app: undefined as unknown as express.Express,
      adminApp: undefined as unknown as express.Express,
      hostTokens: new Map<string, string>(),
    }

    const violation = (message: string) => {
      H.violations.push(message)
    }

    // ── scheduler gates ───────────────────────────────────────────────────────

    async function gate(label: string): Promise<void> {
      const s = H.s
      if (!s) return
      await s.schedule(Promise.resolve(), label)
    }

    /** Runs `work` after every database statement released before it, alone. */
    function serialized<T>(work: () => Promise<T>): Promise<T> {
      const run = H.dbTail.then(work)
      H.dbTail = run.then(
        () => undefined,
        () => undefined
      )
      return run
    }

    async function gatedQuery(text: string, values?: unknown[]): Promise<QueryResult> {
      const req = als.getStore()
      await gate(`db:${sqlLabel(text)}`)
      return serialized(async () => {
        const seq = ++H.seq
        const cls = classify(text)
        const vals = values ?? []
        if (H.failPurges > 0 && cls === 'purgeExcept' && vals[3] == null) {
          H.failPurges -= 1
          recordStatement({ seq, req, cls, values: vals, failed: true, injected: true })
          throw new Error('injected purge failure')
        }
        let result: QueryResult
        try {
          result = await dbPool.query(text, values)
        } catch (err) {
          recordStatement({ seq, req, cls, values: vals, failed: true })
          throw err
        }
        recordStatement({ seq, req, cls, values: vals, result })
        return result
      })
    }

    const gatedDb: DbClient = { query: (text, values) => gatedQuery(text, values as unknown[]) }

    /** Transaction clients: ungated, observed; BEGIN takes its place in the statement order. */
    const txPool = {
      connect: async () => {
        const client = (await dbPool.connect()) as PoolClient
        let beginSeq = 0
        const query = (text: unknown, values?: unknown) => {
          if (typeof text !== 'string') {
            return (client.query as (...a: unknown[]) => unknown)(text, values)
          }
          if (/^\s*BEGIN\b/i.test(text)) {
            return serialized(async () => {
              beginSeq = ++H.seq
              return client.query(text, values as unknown[])
            })
          }
          const req = als.getStore()
          return client.query(text, values as unknown[]).then(result => {
            observeTxStatement(req, text, (values as unknown[]) ?? [], result, beginSeq)
            return result
          })
        }
        return new Proxy(client, {
          get(target, prop) {
            if (prop === 'query') return query
            const value = Reflect.get(target, prop, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      },
    }

    function gatedGateway(gw: MockGateway): MockGateway {
      const run = async (op: string, label: string, call: () => Promise<unknown>) => {
        const req = als.getStore()
        await gate(`gw.${op}:${label}`)
        const seq = ++H.seq
        try {
          const out = await call()
          observeGateway(req, seq, op, label, out, undefined)
          return out
        } catch (err) {
          observeGateway(req, seq, op, label, undefined, err)
          throw err
        }
      }
      return new Proxy(gw, {
        get(target, prop) {
          switch (prop) {
            case 'getResource':
              return (plural: string, name: string, ns?: string) =>
                run('get', `${plural}/${name}`, () => target.getResource(plural as never, name, ns))
            case 'listResource':
              return (plural: string, ns?: string) =>
                run('list', plural, () => target.listResource(plural as never, ns))
            case 'createResource':
              return (plural: string, body: { metadata: { name: string } }, ns?: string) =>
                run('create', `${plural}/${body.metadata.name}`, () =>
                  target.createResource(plural as never, body as never, ns)
                )
            case 'updateResource':
              return (plural: string, name: string, body: unknown, ns?: string) =>
                run('update', `${plural}/${name}`, () =>
                  target.updateResource(plural as never, name, body as never, ns)
                )
            case 'deleteResource':
              return (plural: string, name: string, ns?: string, pre?: unknown) =>
                run('delete', `${plural}/${name}`, async () => {
                  // The apiserver answers a delete of a missing Context with 404.
                  const present = await target.listResource(plural as never, ns)
                  if (
                    plural === 'contexts' &&
                    !(present as Array<{ metadata: { name: string } }>).some(
                      item => item.metadata.name === name
                    )
                  ) {
                    throw Object.assign(new Error(`contexts "${name}" not found`), { code: 404 })
                  }
                  return target.deleteResource(plural as never, name, ns, pre as never)
                })
            case 'getSecret':
              return (name: string, ns?: string) =>
                run('getSecret', name, () => target.getSecret(name, ns))
            default: {
              const value = Reflect.get(target, prop, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          }
        },
      })
    }

    // ── observation → model ───────────────────────────────────────────────────

    function observeGateway(
      req: Req | undefined,
      seq: number,
      op: string,
      label: string,
      out: unknown,
      err: unknown
    ): void {
      const [plural, name] = label.split('/')
      const m = H.model
      if (op === 'get' && req) {
        if (plural === 'contexts') {
          req.ctxReads.push(
            err
              ? { name, found: false, live: false, servers: new Set(), seq }
              : { ...ctxObsFrom(name, out), seq }
          )
        } else if (plural === 'hosts') {
          const host = out as { spec?: { contextRef?: string } } | undefined
          req.hostReads.push({ name, found: !err, contextRef: host?.spec?.contextRef })
        }
      }
      if (op === 'list' && plural === 'contexts' && req && !err) {
        const map = new Map<string, CtxObs>()
        for (const item of out as Array<{ metadata: { name: string } }>) {
          map.set(item.metadata.name, ctxObsFrom(item.metadata.name, item))
        }
        req.ctxLists.push(map)
        if (req.kind === 'sweep') {
          req.listSeq = seq
          req.listedLive = [...map.values()].filter(c => c.live).length
        }
      }
      if (plural === 'contexts' && (op === 'create' || op === 'update' || op === 'delete')) {
        const ownWrite = req && (req.kind === 'put' || req.kind === 'delete' || req.kind === 'post')
        if (err) {
          if (ownWrite && !req.ctxWrite) req.ctxWrite = { ok: false, seq }
          return
        }
        m.ctxWrites.push({ seq, name, reqId: req?.id })
        if (op === 'delete') {
          m.contexts.delete(name)
          if (ownWrite) req.ctxWrite = { ok: true, seq, servers: new Set() }
          return
        }
        const cr = out as { metadata: { uid: string }; spec?: { contextId?: string } }
        const servers = contextAllowlistOf(cr.spec)
        m.contexts.set(name, { uid: cr.metadata.uid, servers, contextId: cr.spec?.contextId })
        if (ownWrite) req.ctxWrite = { ok: true, seq, servers, uid: cr.metadata.uid }
        if (op === 'create') {
          m.incarnations.set(cr.metadata.uid, {
            uid: cr.metadata.uid,
            seq,
            by: !req ? 'setup' : req.kind === 'post' ? 'admin' : 'external',
            reqId: req?.id,
          })
        }
      }
      if (plural === 'hosts' && (op === 'create' || op === 'update') && !err) {
        const host = out as { spec?: { contextRef?: string } }
        m.hosts.set(name, host.spec?.contextRef ?? '')
      }
    }

    function recordStatement(st: {
      seq: number
      req: Req | undefined
      cls: StatementClass
      values: unknown[]
      result?: QueryResult
      failed?: boolean
      /** The failure was injected by the run (a dropped connection), not raised by Postgres. */
      injected?: boolean
    }): void {
      try {
        applyStatement(st)
      } catch (err) {
        violation(`model: ${(err as Error).message}`)
      }
    }

    function applyStatement(st: {
      seq: number
      req: Req | undefined
      cls: StatementClass
      values: unknown[]
      result?: QueryResult
      failed?: boolean
      injected?: boolean
    }): void {
      const { seq, req, cls, values, result } = st
      const m = H.model
      const obs: StatementObs = { seq, cls, values }
      if (st.failed) obs.failed = true
      if (req) req.statements.push(obs)
      const createPurge =
        cls === 'purgeExcept' && values[3] == null && req?.kind === 'post' && req.ctxWrite?.uid
          ? m.incarnations.get(req.ctxWrite.uid)
          : undefined
      const hookPurge = cls === 'purgeExcept' && values[3] == null
      if (createPurge) {
        createPurge.purgeSeq = seq
        createPurge.purgeFailed = !!st.injected
      }
      if (st.failed) {
        // Only a failure the run injected stands for the outage the routes
        // tolerate; Postgres rejecting the purge itself is a broken purge.
        if (hookPurge && st.injected && req) req.hookFailed = true
        else if (hookPurge) violation(`${req?.label ?? 'hook'}: Postgres rejected the purge`)
        return
      }
      const rows = result?.rows ?? []
      switch (cls) {
        case 'readUserContexts':
          req?.userContextsReads.push(
            rows.map(r => String((r as { context_id: string }).context_id))
          )
          return
        case 'readUserAgents':
          req?.userAgentsReads.push(rows.map(r => String((r as { agent_name: string }).agent_name)))
          return
        case 'readGrants':
          observeGrantRead(req, rows as Array<Record<string, unknown>>)
          return
        case 'clock': {
          const text = String((rows[0] as { tick_start: string }).tick_start)
          m.clocks.set(text, seq)
          if (req) req.clockSeq = seq
          return
        }
        case 'bootstrap': {
          const [, ns, server, context, , user, , , , , crUid] = values as string[]
          if (ns !== NS) violation(`bootstrap in namespace ${ns}`)
          const key = sharedKey(server, context)
          const existing = m.rows.get(key)
          const predicted = !existing || existing.crUid !== (crUid ?? null)
          const real = (result?.rowCount ?? 0) > 0
          if (predicted !== real) {
            violation(
              `model≠db: bootstrap ${key} predicted ${predicted ? 'write' : 'no-op'}, Postgres ${real ? 'wrote' : 'did nothing'}`
            )
          }
          checkInsertProvenance(req, server, context, user)
          m.grantWrites.push({ seq, context, reqId: req?.id, refresh: false })
          if (real) {
            m.rows.set(key, {
              kind: 'shared',
              server,
              owner: context,
              bootstrappedBy: user,
              crUid: crUid ?? null,
              insertSeq: seq,
              updSeq: seq,
              c5Uid: req ? lastCtxRead(req, context)?.uid : undefined,
            })
          }
          return
        }
        case 'userUpsert': {
          const [, , server, user, , , , , , crUid] = values as string[]
          if (!req || req.kind !== 'callback' || req.claims?.server !== server) {
            violation(`user grant ${server}/${user} written outside its callback`)
          }
          m.grantWrites.push({ seq, reqId: req?.id, refresh: false })
          m.rows.set(userKey(server, user), {
            kind: 'user',
            server,
            owner: user,
            crUid: crUid ?? null,
            insertSeq: seq,
            updSeq: seq,
          })
          return
        }
        case 'purgeExcept':
        case 'purgeMissing': {
          const ns = values[0]
          if (ns !== NS) violation(`purge keyed by namespace ${String(ns)}, rows live in ${NS}`)
          const before = cls === 'purgeExcept' ? values[3] : values[2]
          let tickSeq: number | null = null
          if (before != null) {
            const known = m.clocks.get(String(before))
            if (known === undefined) {
              violation(`purge fenced by ${String(before)}, which is no database clock read`)
              return
            }
            tickSeq = known
          }
          const matches = (row: Row) => {
            if (row.kind !== 'shared') return false
            if (cls === 'purgeExcept') {
              if (row.owner !== values[1]) return false
              if ((values[2] as string[]).includes(row.server)) return false
            } else if ((values[1] as string[]).includes(row.owner)) {
              return false
            }
            return tickSeq === null || row.updSeq < tickSeq
          }
          if (tickSeq !== null) {
            // Rows this tick would have deleted but for its clock: what S-8 is about.
            obs.fencedOut = [...m.rows.values()].filter(
              row => matches({ ...row, updSeq: -1 }) && !matches(row)
            ).length
          }
          const predicted = [...m.rows.entries()]
            .filter(([, row]) => matches(row))
            .map(([, row]) => `${row.server}|${row.owner}`)
            .sort()
          const deleted = rows
            .map(r => {
              const row = r as { recipe_name: string; context_id: string | null }
              return `${row.recipe_name}|${row.context_id}`
            })
            .sort()
          obs.deleted = deleted
          if (cls === 'purgeExcept' && values[3] == null && req?.kind === 'post') {
            obs.earlierIncarnationPurged = deleted.length
          }
          if (JSON.stringify(predicted) !== JSON.stringify(deleted)) {
            violation(
              `model≠db: ${cls}(${JSON.stringify(values.slice(1, 3))}) predicted ${JSON.stringify(predicted)}, Postgres deleted ${JSON.stringify(deleted)}`
            )
          }
          if (req?.kind === 'sweep') {
            for (const key of deleted) {
              const [server, context] = key.split('|')
              const row = m.rows.get(sharedKey(server, context))
              if (row && req.clockSeq !== undefined && row.updSeq >= req.clockSeq) {
                violation(`sweep deleted ${key}, written at or after its clock read`)
              }
            }
          }
          for (const key of deleted) {
            const [server, context] = key.split('|')
            if (context === 'null') {
              violation(`purge deleted a non-shared grant of ${server}`)
              continue
            }
            m.rows.delete(sharedKey(server, context))
            m.grantDeletes.push({ seq, context })
          }
          return
        }
        case 'deleteShared': {
          const [, ns, server, context] = values as string[]
          if (ns !== NS) violation(`revoke in namespace ${ns}`)
          const key = sharedKey(server, context)
          const predicted = m.rows.has(key) ? 1 : 0
          const real = result?.rowCount ?? 0
          if (predicted !== real) {
            violation(`model≠db: revoke ${key} predicted ${predicted} rows, Postgres ${real}`)
          }
          if (real > 0) {
            m.rows.delete(key)
            m.grantDeletes.push({ seq, context })
          }
          return
        }
        case 'otherGrantWrite':
          violation(`unexpected grant write: ${JSON.stringify(values.slice(0, 5))}`)
          return
        default:
          return
      }
    }

    function observeGrantRead(req: Req | undefined, rows: Array<Record<string, unknown>>): void {
      if (!req) return
      req.grantReads.push(rows)
      if (req.kind === 'broker') {
        const shared = rows.find(r => r.grant_kind === 'shared' && r.recipe_name === SC)
        const row = shared && H.model.rows.get(sharedKey(SC, String(shared.context_id)))
        req.servedRow = row ? { c5Uid: row.c5Uid, insertSeq: row.insertSeq } : null
      }
    }

    function observeTxStatement(
      req: Req | undefined,
      text: string,
      values: unknown[],
      result: QueryResult,
      beginSeq: number
    ): void {
      const sql = text.replace(/\s+/g, ' ')
      try {
        if (/UPDATE oauth_grants/.test(sql)) {
          const shared = /grant_kind = 'shared'/.test(sql)
          if (shared && (result.rowCount ?? 0) > 0) {
            const key = sharedKey(String(values[2]), String(values[3]))
            const row = H.model.rows.get(key)
            if (!row) violation(`model≠db: refresh updated ${key}, absent from the model`)
            else row.updSeq = beginSeq
            H.model.grantWrites.push({
              seq: ++H.seq,
              context: String(values[3]),
              reqId: req?.id,
              refresh: true,
            })
          }
          return
        }
        if (/FROM oauth_grants/.test(sql) && /^\s*SELECT/i.test(sql)) {
          if (/^\s*SELECT 1 FROM oauth_grants\b.*\bFOR UPDATE\s*$/i.test(sql)) {
            req?.lockReads.push((result.rowCount ?? 0) > 0)
          } else observeGrantRead(req, result.rows as Array<Record<string, unknown>>)
        }
      } catch (err) {
        violation(`model: ${(err as Error).message}`)
      }
    }

    // ── per-request predicates over what the request itself read ──────────────

    const lastCtxRead = (req: Req, context: string) =>
      [...req.ctxReads].reverse().find(r => r.name === context)

    function contextEnables(req: Req, context: string, server: string): boolean {
      const read = lastCtxRead(req, context)
      return !!read && read.found && read.live && read.servers.has(server)
    }

    function contextLive(req: Req, context: string): boolean {
      const read = lastCtxRead(req, context)
      return !!read && read.found && read.live
    }

    /**
     * Whether the user reached the Context during the request. From the request's
     * own membership reads when it made them; when the code under test decided
     * without reading them, from the model, unless a membership or Host write
     * overlapped the request (then `undefined`: not decidable).
     */
    function reachOf(req: Req, user: string, context: string): boolean | undefined {
      if (req.userContextsReads.length > 0) return reachObserved(req, context)
      const overlapped = H.model.accessWrites.some(
        w => w.start <= req.endSeq! && w.end >= req.startSeq
      )
      if (overlapped) return undefined
      if ((H.model.userContexts.get(user) ?? []).includes(context)) return true
      return (H.model.userAgents.get(user) ?? []).some(h => H.model.hosts.get(h) === context)
    }

    function reachObserved(req: Req, context: string): boolean {
      if (req.userContextsReads.at(-1)?.includes(context)) return true
      const agents = req.userAgentsReads.at(-1) ?? []
      return req.hostReads.some(h => h.found && agents.includes(h.name) && h.contextRef === context)
    }

    /** The user-scope rule: some Context the user reaches enables the server. */
    function userScopeObserved(req: Req, server: string): { allowed: boolean; denied: boolean } {
      const direct = req.userContextsReads.at(-1) ?? []
      const agents = req.userAgentsReads.at(-1) ?? []
      const viaHosts = req.hostReads
        .filter(h => h.found && agents.includes(h.name) && h.contextRef)
        .map(h => h.contextRef as string)
      const reached = new Set([...direct, ...viaHosts])
      const enables = (list: Map<string, CtxObs>) =>
        [...reached].some(name => {
          const c = list.get(name)
          return !!c && c.live && c.servers.has(server)
        })
      const lastList = req.ctxLists.at(-1)
      return {
        allowed: req.ctxLists.some(enables),
        denied: !lastList || !enables(lastList),
      }
    }

    function checkInsertProvenance(
      req: Req | undefined,
      server: string,
      context: string,
      user: string
    ): void {
      const claims = req?.claims
      if (!req || req.kind !== 'callback' || !claims || claims.legacy) {
        violation(`shared grant ${server}/${context} inserted outside a consent callback`)
        return
      }
      if (claims.server !== server || claims.context !== context || claims.user !== user) {
        violation(
          `shared grant ${server}/${context} by ${user} does not match its signed state ${JSON.stringify(claims)}`
        )
      }
      if (!contextEnables(req, context, server) || !reachObserved(req, context)) {
        violation(
          `shared grant ${server}/${context} inserted although the callback did not see the Context enable it and the user reach it`
        )
      }
    }

    const hookPurges = (req: Req) =>
      req.statements.filter(st => st.cls === 'purgeExcept' && st.values[3] == null)

    const writesOnContextDuring = (req: Req, context: string) =>
      H.model.ctxWrites.some(
        w =>
          w.name === context && w.reqId !== req.id && w.seq >= req.startSeq && w.seq <= req.endSeq!
      ) ||
      H.model.grantWrites.some(
        w =>
          !w.refresh &&
          w.context === context &&
          w.reqId !== req.id &&
          w.seq >= req.startSeq &&
          w.seq <= req.endSeq!
      )

    /**
     * A row consented in an earlier incarnation of its Context, kept or served
     * for the current one, is only allowed where it cannot be told apart:
     *   - the current incarnation was created outside control-api, where no
     *     route purges what an earlier Context of the same name left;
     *   - the admin create purged first and the consent landed after that purge
     *     (it was validated against the old Context and inserted under the name);
     *   - the admin create's own purge ran and failed: the write already
     *     happened and the sweep cannot tell incarnations apart either, so the
     *     row stays until a member revokes it.
     * Anything else (an admin create whose purge succeeded before the insert)
     * is a violation.
     */
    function incarnationMismatchAllowed(incarnationUid: string, insertSeq: number): boolean {
      H.incarnationJudged += 1
      const born = H.model.incarnations.get(incarnationUid)
      if (!born || born.by === 'setup') return false
      if (born.by === 'external') return true
      if (born.purgeFailed) return true
      return born.purgeSeq !== undefined && insertSeq > born.purgeSeq
    }

    // ── checks per command ────────────────────────────────────────────────────

    function checkMint(req: Req, server: string, context: string | undefined): void {
      const status = req.status
      if (server === SU) {
        if (status === 400)
          violation(`${req.label}: user-scope mint answered 400 for its contextId`)
        const rule = userScopeObserved(req, SU)
        if (status === 200 && !rule.allowed) {
          violation(`${req.label}: 200 although no Context it read enables the server for the user`)
        }
        if (status === 403 && !rule.denied) violation(`${req.label}: 403 although it read access`)
        if (status !== 200 && status !== 403) violation(`${req.label}: status ${status}`)
        return
      }
      if (context === undefined) {
        if (status !== 400 || (req.body as { error?: string })?.error !== 'context_required') {
          violation(`${req.label}: expected 400 context_required, got ${status}`)
        }
        return
      }
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(context)) {
        if (status !== 400) violation(`${req.label}: malformed contextId answered ${status}`)
        return
      }
      const ok = contextEnables(req, context, SC) && reachObserved(req, context)
      if (status === 200 && !ok) {
        violation(`${req.label}: authorize URL issued without the Context enabling it and reach`)
      } else if (status !== 200 && ok) {
        violation(`${req.label}: ${status} although every read allowed the consent`)
      } else if (status !== 200 && status !== 403) {
        violation(`${req.label}: denial with status ${status}`)
      }
    }

    function checkCallback(req: Req): void {
      const claims = req.claims!
      const codePosts = req.idpPosts.filter(g => g === 'authorization_code').length
      const writes = req.statements.filter(
        st => st.cls === 'bootstrap' || st.cls === 'userUpsert' || st.cls.startsWith('purge')
      )
      if (claims.legacy) {
        if (
          req.status !== 400 ||
          (req.body as { error?: string })?.error !== 'oauth_state_outdated'
        ) {
          violation(`${req.label}: outdated state answered ${req.status}`)
        }
        if (codePosts !== 0) violation(`${req.label}: outdated state reached the provider`)
        if (writes.length !== 0) violation(`${req.label}: outdated state wrote grants`)
        return
      }
      if (claims.server === SU) {
        const rule = userScopeObserved(req, SU)
        const ok = req.status === 200
        if (ok && !rule.allowed) violation(`${req.label}: user grant stored without access`)
        if (!ok && !rule.denied) violation(`${req.label}: ${req.status} although it read access`)
        if (codePosts > (rule.allowed ? 1 : 0)) violation(`${req.label}: ${codePosts} code POSTs`)
        return
      }
      const passed = contextEnables(req, claims.context!, SC) && reachObserved(req, claims.context!)
      if (codePosts > (passed ? 1 : 0)) {
        violation(`${req.label}: ${codePosts} code POSTs (access re-check passed: ${passed})`)
      }
      if (passed) {
        if (req.status !== 200)
          violation(`${req.label}: ${req.status} although the re-check passed`)
        if (req.statements.filter(st => st.cls === 'bootstrap').length !== 1) {
          violation(`${req.label}: completed without exactly one grant insert`)
        }
      } else {
        if (req.status !== 403)
          violation(`${req.label}: ${req.status} although the re-check failed`)
        if (writes.length !== 0) violation(`${req.label}: refused callback wrote grants`)
      }
    }

    function checkDisconnect(req: Req, user: string, context: string): void {
      const deletes = req.statements.filter(
        st =>
          st.cls.startsWith('purge') || st.cls === 'deleteShared' || st.cls === 'otherGrantWrite'
      )
      for (const st of deletes) {
        if (st.cls !== 'deleteShared' || st.values[3] !== context || st.values[2] !== SC) {
          violation(`${req.label}: revoke touched more than (${SC}, ${context}): ${st.cls}`)
        }
      }
      const reach = reachOf(req, user, context)
      if (reach === undefined) return
      const ok = contextLive(req, context) && reach
      if (ok && req.status !== 204) violation(`${req.label}: ${req.status} for a member`)
      if (!ok && req.status !== 403) violation(`${req.label}: ${req.status} for a non-member`)
      if (ok !== (deletes.length === 1)) violation(`${req.label}: ${deletes.length} revokes`)
    }

    function checkContextWrite(req: Req, context: string, okStatus: number): void {
      // Every body the commands send is valid: the allowlist they chose and a
      // contextId that is either the name or the value the Context already holds.
      if (req.status === 422)
        violation(`${req.label}: refused as invalid: ${JSON.stringify(req.body)}`)
      const purges = hookPurges(req)
      const written = req.ctxWrite?.ok === true
      if (written !== (purges.length === 1) || purges.length > 1) {
        violation(
          `${req.label}: ${purges.length} purge statements after a ${written ? 'persisted' : 'refused'} write`
        )
        return
      }
      if (!written) {
        if (req.status === okStatus) violation(`${req.label}: ${okStatus} for a refused write`)
        return
      }
      if (req.hookFailed && req.status !== okStatus) {
        violation(`${req.label}: a failed purge changed the answer to ${req.status}`)
      }
      if (req.hookFailed) return
      if (req.status !== okStatus) violation(`${req.label}: persisted but answered ${req.status}`)
      const keep = purges[0]
      const expectedKeep = req.kind === 'put' ? [...(req.ctxWrite!.servers ?? [])].sort() : []
      if (
        keep.values[1] !== context ||
        JSON.stringify([...(keep.values[2] as string[])].sort()) !== JSON.stringify(expectedKeep)
      ) {
        violation(
          `${req.label}: purge kept ${JSON.stringify(keep.values[2])} of ${String(keep.values[1])}, not the persisted ${JSON.stringify(expectedKeep)}`
        )
      }
      if (req.kind === 'post') {
        const stale = [...H.model.rows.values()].filter(
          r => r.kind === 'shared' && r.owner === context && r.insertSeq < req.ctxWrite!.seq
        )
        if (stale.length > 0) {
          violation(`${req.label}: rows of an earlier incarnation survive the create`)
        }
        return
      }
      if (writesOnContextDuring(req, context)) return
      const final = req.kind === 'put' ? (req.ctxWrite!.servers ?? new Set()) : new Set<string>()
      const left = [...H.model.rows.values()].filter(
        r => r.kind === 'shared' && r.owner === context && !final.has(r.server)
      )
      if (left.length > 0) {
        violation(
          `${req.label}: ${left.map(r => r.server).join(',')} still granted in ${context} after its write`
        )
      }
    }

    function checkSweep(req: Req): void {
      const clockReads = req.statements.filter(st => st.cls === 'clock').length
      const lists = req.ctxLists.length
      const purges = req.statements.filter(st => st.cls.startsWith('purge'))
      if (req.sweepOutcome === 'skipped') {
        if (req.statements.length > 0 || lists > 0) violation(`${req.label}: skipped tick did work`)
        return
      }
      if (clockReads !== 1 || lists !== 1) {
        violation(`${req.label}: ${clockReads} clock reads and ${lists} lists`)
      }
      const live = req.listedLive ?? 0
      if (live === 0 && purges.length > 0) violation(`${req.label}: deleted on an empty list`)
      if (purges.length > live + 1) violation(`${req.label}: ${purges.length} deletes for ${live}`)
      if (req.sweepOutcome !== 'completed' || req.clockSeq === undefined) return
      if (req.listSeq === undefined) return
      const laterGrantWrite = H.model.grantWrites.some(
        w => w.seq > req.clockSeq! && w.seq <= req.endSeq!
      )
      const contextWriteAfterList = H.model.ctxWrites.some(
        w => w.seq > req.listSeq! && w.seq <= req.endSeq!
      )
      if (laterGrantWrite || contextWriteAfterList) return
      for (const row of H.model.rows.values()) {
        if (row.kind !== 'shared') continue
        const ctx = H.model.contexts.get(row.owner)
        if (!ctx || !ctx.servers.has(row.server)) {
          violation(`${req.label}: ${row.server}/${row.owner} survives a quiet tick unenabled`)
        }
      }
    }

    function checkBroker(req: Req, host: string, rowAtStart: boolean): void {
      const hostRead = req.hostReads.find(h => h.name === host)
      const context = hostRead?.contextRef
      // The grant existed for the whole request: nothing inserted, refreshed or
      // removed a row of that Context meanwhile, so the broker had to serve it.
      if (context && rowAtStart && H.model.rows.has(sharedKey(SC, context))) {
        const touched =
          H.model.grantDeletes.some(
            d => d.context === context && d.seq >= req.startSeq && d.seq <= req.endSeq!
          ) ||
          H.model.grantWrites.some(
            w =>
              w.context === context &&
              w.reqId !== req.id &&
              w.seq >= req.startSeq &&
              w.seq <= req.endSeq!
          )
        if (!touched && contextEnables(req, context, SC) && req.status !== 200) {
          violation(
            `${req.label}: ${req.status} although its Context enables it and the grant stood throughout`
          )
        }
      }
      const conditions = !!hostRead?.found && !!context && contextEnables(req, context, SC)
      const lastGrants = req.grantReads.at(-1) ?? []
      const rowSeen = lastGrants.some(
        r => r.grant_kind === 'shared' && r.recipe_name === SC && r.context_id === context
      )
      if (req.status === 200 && !(conditions && rowSeen)) {
        violation(`${req.label}: token served without its Host's Context enabling it and a grant`)
      }
      if (req.status !== 200 && conditions && rowSeen) {
        violation(`${req.label}: ${req.status} although the Context enables it and a grant exists`)
      }
      if (req.status === 200 && context) {
        // Judged against the incarnation the broker read and the row it read,
        // not against whatever the model holds once the request has ended.
        const ctxUid = lastCtxRead(req, context)?.uid
        const served = req.servedRow
        if (served?.c5Uid && ctxUid && served.c5Uid !== ctxUid) {
          if (!incarnationMismatchAllowed(ctxUid, served.insertSeq)) {
            violation(
              `${req.label}: served a grant consented for an earlier incarnation of ${context}`
            )
          }
        }
      }
    }

    // ── requests ──────────────────────────────────────────────────────────────

    function newReq(kind: ReqKind, label: string, extra: Partial<Req> = {}): Req {
      const id = `r${++H.reqCounter}`
      const req: Req = {
        id,
        kind,
        label: `${label}#${id}`,
        startSeq: H.seq,
        ctxReads: [],
        hostReads: [],
        ctxLists: [],
        userContextsReads: [],
        userAgentsReads: [],
        grantReads: [],
        lockReads: [],
        statements: [],
        idpPosts: [],
        ...extra,
      }
      H.reqs.set(id, req)
      return req
    }

    async function send(req: Req, test: request.Test): Promise<request.Response> {
      const res = await test.set('x-oracle-req', req.id)
      req.endSeq = H.seq
      req.status = res.status
      req.body = res.body
      return res
    }

    /** Runs the request's handlers inside its record, after the body is parsed. */
    function withRequestRecord(inner: express.Express): express.Express {
      const outer = express()
      outer.use(express.json())
      outer.use((req, _res, next) => {
        const id = req.header('x-oracle-req')
        const rec = id ? H.reqs.get(id) : undefined
        if (rec) als.run(rec, next)
        else next()
      })
      outer.use(inner)
      return outer
    }

    async function mint(user: string, server: string, context: string | undefined) {
      const req = newReq('mint', `Mint(${user.slice(0, 4)},${server},${String(context)})`)
      const res = await send(
        req,
        request(H.app)
          .post('/api/v1/internal/mcp-oauth/authorize-url')
          .set('Authorization', 'Bearer dev-rpc-proxy-token')
          .set('x-service-token', 'rpc-proxy')
          .send({ mcpServerName: server, userId: user, ...(context ? { contextId: context } : {}) })
      )
      return { req, res }
    }

    async function callback(record: MintRecord, label: string): Promise<void> {
      const req = newReq('callback', label, { claims: record.claims })
      await send(
        req,
        request(H.app)
          .get(`/api/v1/oauth-callback/${OAUTH_ID}`)
          .query({ code: `CODE-${randomUUID()}`, state: record.state })
      )
      checkCallback(req)
    }

    async function adminPut(context: string, servers: string[], withRv: boolean): Promise<void> {
      let spec: Record<string, unknown> = { contextId: context, mcpServers: servers }
      let resourceVersion: string | undefined
      if (withRv) {
        const client = newReq('client', `read ${context}`)
        const current = (await als
          .run(client, () => H.gated.getResource('contexts', context, CTX_NS))
          .catch(() => null)) as {
          metadata: { resourceVersion?: string }
          spec: Record<string, unknown>
        } | null
        if (current) {
          spec = { ...current.spec, mcpServers: servers }
          resourceVersion = current.metadata.resourceVersion
        }
      }
      const req = newReq(
        'put',
        `AdminPut${withRv ? '' : 'NoRv'}(${context},[${servers.join(',')}])`,
        {
          context,
          aliasResent: typeof spec.contextId === 'string' && spec.contextId !== context,
        }
      )
      await send(
        req,
        request(H.adminApp)
          .put(`/api/v1/admin/contexts/${context}`)
          .send({ ...(resourceVersion ? { metadata: { resourceVersion } } : {}), spec })
      )
      checkContextWrite(req, context, 200)
    }

    async function adminDelete(context: string): Promise<void> {
      const req = newReq('delete', `AdminDelete(${context})`, { context })
      await send(req, request(H.adminApp).delete(`/api/v1/admin/contexts/${context}`))
      checkContextWrite(req, context, 200)
    }

    async function recreate(context: string, servers: string[]): Promise<void> {
      const req = newReq('post', `Recreate(${context},[${servers.join(',')}])`, { context })
      await send(
        req,
        request(H.adminApp)
          .post('/api/v1/admin/contexts')
          .send({ metadata: { name: context }, spec: { contextId: context, mcpServers: servers } })
      )
      checkContextWrite(req, context, 201)
    }

    async function external(label: string, work: () => Promise<unknown>): Promise<void> {
      const req = newReq('external', label)
      await als.run(req, work).catch(() => undefined)
      req.endSeq = H.seq
    }

    async function broker(host: HostName, label: string): Promise<void> {
      const req = newReq('broker', label)
      const ctxAtStart = H.model.hosts.get(host)
      const rowAtStart = !!ctxAtStart && H.model.rows.has(sharedKey(SC, ctxAtStart))
      await send(
        req,
        request(H.app)
          .post('/api/v1/mcp-oauth/user-token')
          .set('Authorization', `Bearer ${H.hostTokens.get(host)}`)
          .send({ mcpServerName: SC })
      )
      checkBroker(req, host, rowAtStart)
    }

    async function sweep(): Promise<void> {
      const req = newReq('sweep', 'Sweep()')
      const summary = await als.run(req, () =>
        runSharedGrantSweep({
          gateway: H.gated as never,
          db: gatedDb,
          contextsNamespace: CTX_NS,
          mcpServersNamespace: NS,
        })
      )
      req.endSeq = H.seq
      req.sweepOutcome = summary.outcome
      checkSweep(req)
    }

    async function adminCall(test: request.Test, expected: number): Promise<request.Response> {
      const res = await test
      if (res.status !== expected) {
        throw new Error(`setup ${res.status} ${res.text}`)
      }
      return res
    }

    // ── commands ──────────────────────────────────────────────────────────────

    interface Step {
      readonly parallel: boolean
      run(): Promise<void>
      toString(): string
    }

    const userLabel = (u: number) => `U${u + 1}`

    class Mint implements Step {
      readonly parallel = false
      constructor(
        readonly u: number,
        readonly server: string,
        readonly context: string | undefined
      ) {}
      async run() {
        const user = users[this.u]
        const { req, res } = await mint(user, this.server, this.context)
        checkMint(req, this.server, this.context)
        if (res.status === 200) {
          const state = new URL(res.body.authorizeUrl as string).searchParams.get('state') ?? ''
          H.mints.push({
            state,
            claims: { server: this.server, user, context: this.context, legacy: false },
          })
        }
      }
      toString() {
        return `Mint(${userLabel(this.u)},${this.server},${String(this.context)})`
      }
    }

    /** The panel's Connect: a mint, then its callback left in flight. */
    class Connect implements Step {
      readonly parallel = false
      constructor(
        readonly u: number,
        readonly server: string,
        readonly context: string
      ) {}
      async run() {
        const before = H.mints.length
        await new Mint(this.u, this.server, this.context).run()
        if (H.mints.length === before) return
        const record = H.mints[H.mints.length - 1]
        H.usedStates.push(record)
        H.background.push(
          callback(record, `${this.toString()}→callback`).catch(err => {
            violation(`${this.toString()} callback threw: ${(err as Error).stack ?? String(err)}`)
          })
        )
      }
      toString() {
        return `Connect(${userLabel(this.u)},${this.server},${this.context})`
      }
    }

    /**
     * A consent left in flight for a direct member of c1, a sweep, and a write
     * outside control-api that takes the server away (or the whole Context), all
     * racing: the orderings where the insert lands after the sweep read its clock
     * but before it deletes are the ones its clock fence exists for.
     */
    class SweepRace implements Step {
      readonly parallel = false
      constructor(readonly mode: 'remove' | 'delete') {}
      async run() {
        // Revoked first, so the racing consent inserts a new row instead of
        // re-consenting over the existing one (a no-op that keeps its old stamp).
        await new Disconnect(0, 'c1').run()
        let parked!: () => void
        const atProvider = new Promise<void>(resolve => (parked = resolve))
        H.onCodeExchange = parked
        await new Connect(0, SC, 'c1').run()
        const consent = H.background.at(-1) ?? Promise.resolve()
        // Start the race once the consent is past its access re-check (or was refused).
        await H.s!.waitFor(Promise.race([atProvider, consent]))
        H.onCodeExchange = null
        H.background.push(sweep().catch(err => violation(`sweep threw: ${String(err)}`)))
        const write =
          this.mode === 'remove' ? new External('c1', SC, false) : new ExternalDelete('c1')
        H.background.push(write.run())
      }
      toString() {
        return `SweepRace(${this.mode})`
      }
    }

    /**
     * Delete a Context and create it again under the same name, optionally with a
     * consent still in flight across both writes and with the delete's purge
     * failing: what leaves rows of an earlier incarnation for the create to purge
     * or for the checks to judge.
     */
    class DeleteAndRecreate implements Step {
      readonly parallel = false
      constructor(
        readonly via: 'admin' | 'external',
        readonly failDeletePurge: boolean,
        readonly inFlight: boolean
      ) {}
      async run() {
        if (this.inFlight) await new Connect(0, SC, 'c1').run()
        if (this.via === 'admin') {
          if (this.failDeletePurge) H.failPurges += 1
          await adminDelete('c1')
          await recreate('c1', [SC, SU])
        } else {
          await new ExternalDelete('c1').run()
          await new ExternalCreate('c1', [SC, SU], false).run()
        }
      }
      toString() {
        return `DeleteAndRecreate(${this.via},${this.failDeletePurge ? 'failDeletePurge' : 'ok'},${this.inFlight ? 'inFlight' : 'quiet'})`
      }
    }

    /**
     * A broker read whose refresh races a revoke or a purge of the same grant:
     * the row can vanish between the broker's first read and its row lock.
     */
    class RefreshRace implements Step {
      readonly parallel = true
      constructor(readonly mode: 'revoke' | 'purge') {}
      async run() {
        const removal =
          this.mode === 'revoke' ? new Disconnect(0, 'c1').run() : adminPut('c1', [SU], true)
        await Promise.all([broker('h1', this.toString()), removal])
      }
      toString() {
        return `RefreshRace(${this.mode})`
      }
    }

    /**
     * A Context written outside control-api with an alias, then edited through
     * the admin route the way the console does (its spec resent with the RV):
     * the alias it resends unchanged must not be refused.
     */
    class AliasedEdit implements Step {
      readonly parallel = false
      constructor(readonly servers: string[]) {}
      async run() {
        await new ExternalCreate('c3', [SC], true).run()
        await adminPut('c3', this.servers, true)
      }
      toString() {
        return `AliasedEdit([${this.servers.join(',')}])`
      }
    }

    /** Every Context removed outside control-api: what a sweep must not read as "purge all". */
    class WipeContexts implements Step {
      readonly parallel = true
      async run() {
        await Promise.all(CONTEXTS.map(c => new ExternalDelete(c).run()))
      }
      toString() {
        return 'WipeContexts()'
      }
    }

    /** A state signed before Contexts were bound into it, and its callback arriving now. */
    class LegacyCallback implements Step {
      readonly parallel = false
      constructor(readonly u: number) {}
      async run() {
        await new MintLegacy(this.u).run()
        const record = H.mints[H.mints.length - 1]
        H.usedStates.push(record)
        H.background.push(
          callback(record, `${this.toString()}→callback`).catch(err => {
            violation(`${this.toString()} callback threw: ${(err as Error).stack ?? String(err)}`)
          })
        )
      }
      toString() {
        return `LegacyCallback(${userLabel(this.u)})`
      }
    }

    class MintLegacy implements Step {
      readonly parallel = false
      constructor(readonly u: number) {}
      async run() {
        const user = users[this.u]
        // What the release before contextId-bound consent signed for this server.
        const state = signOAuthState(config.oauthStateHmacSecret, {
          subjectKind: 'mcp',
          mcpServerName: SC,
          userId: user,
          oauthClientId: OAUTH_ID,
          grantKind: 'user',
          background: false,
        })
        H.mints.push({ state, claims: { server: SC, user, legacy: true } })
      }
      toString() {
        return `MintLegacy(${userLabel(this.u)})`
      }
    }

    class Callback implements Step {
      readonly parallel = true
      constructor(
        readonly i: number,
        readonly again: boolean
      ) {}
      async run() {
        const pool = this.again ? H.usedStates : H.mints
        if (pool.length === 0) return
        // Most recent first: a consent is usually completed right after its mint.
        const record = pool[pool.length - 1 - (this.i % pool.length)]
        H.usedStates.push(record)
        await callback(record, `${this.toString()}→${JSON.stringify(record.claims)}`)
      }
      toString() {
        return `${this.again ? 'CallbackAgain' : 'Callback'}(${this.i})`
      }
    }

    class AdminPut implements Step {
      readonly parallel = true
      constructor(
        readonly context: string,
        readonly servers: string[],
        readonly withRv: boolean
      ) {}
      run() {
        return adminPut(this.context, this.servers, this.withRv)
      }
      toString() {
        return `AdminPut${this.withRv ? '' : 'NoRv'}(${this.context},[${this.servers.join(',')}])`
      }
    }

    class AdminDelete implements Step {
      readonly parallel = true
      constructor(readonly context: string) {}
      run() {
        return adminDelete(this.context)
      }
      toString() {
        return `AdminDelete(${this.context})`
      }
    }

    class Recreate implements Step {
      readonly parallel = false
      constructor(
        readonly context: string,
        readonly servers: string[]
      ) {}
      run() {
        return recreate(this.context, this.servers)
      }
      toString() {
        return `Recreate(${this.context},[${this.servers.join(',')}])`
      }
    }

    class ExternalCreate implements Step {
      readonly parallel = false
      constructor(
        readonly context: string,
        readonly servers: string[],
        readonly alias: boolean
      ) {}
      run() {
        return external(this.toString(), () =>
          H.gated.createResource(
            'contexts',
            {
              metadata: { name: this.context },
              spec: {
                contextId: this.alias ? `x-${this.context}` : this.context,
                mcpServers: this.servers,
              },
            } as never,
            CTX_NS
          )
        )
      }
      toString() {
        return `ExternalCreate(${this.context},[${this.servers.join(',')}],${this.alias ? 'alias' : 'name'})`
      }
    }

    class External implements Step {
      readonly parallel = true
      constructor(
        readonly context: string,
        readonly server: string,
        readonly add: boolean
      ) {}
      run() {
        return external(this.toString(), async () => {
          const current = (await H.gated.getResource('contexts', this.context, CTX_NS)) as {
            metadata: { resourceVersion?: string }
            spec: Record<string, unknown>
          }
          const allow = contextAllowlistOf(current.spec)
          if (this.add) allow.add(this.server)
          else allow.delete(this.server)
          await H.gated.updateResource(
            'contexts',
            this.context,
            {
              metadata: { resourceVersion: current.metadata.resourceVersion },
              spec: { ...current.spec, mcpServers: [...allow] },
            },
            CTX_NS
          )
        })
      }
      toString() {
        return `External(${this.context},${this.add ? '+' : '-'}${this.server})`
      }
    }

    class ExternalDelete implements Step {
      readonly parallel = true
      constructor(readonly context: string) {}
      run() {
        return external(this.toString(), () =>
          H.gated.deleteResource('contexts', this.context, CTX_NS)
        )
      }
      toString() {
        return `ExternalDelete(${this.context})`
      }
    }

    class FailNextPurge implements Step {
      readonly parallel = false
      async run() {
        H.failPurges += 1
      }
      toString() {
        return 'FailNextPurge()'
      }
    }

    class SetUserContexts implements Step {
      readonly parallel = false
      constructor(
        readonly u: number,
        readonly contexts: string[]
      ) {}
      async run() {
        const user = users[this.u]
        const start = H.seq
        await setUserContexts(user, this.contexts, operator)
        H.model.userContexts.set(user, [...this.contexts])
        H.model.accessWrites.push({ start, end: H.seq })
      }
      toString() {
        return `SetUserContexts(${userLabel(this.u)},[${this.contexts.join(',')}])`
      }
    }

    class SetUserAgents implements Step {
      readonly parallel = false
      constructor(
        readonly u: number,
        readonly hosts: string[]
      ) {}
      async run() {
        const user = users[this.u]
        const start = H.seq
        await setUserAgents(user, this.hosts, operator)
        H.model.userAgents.set(user, [...this.hosts])
        H.model.accessWrites.push({ start, end: H.seq })
      }
      toString() {
        return `SetUserAgents(${userLabel(this.u)},[${this.hosts.join(',')}])`
      }
    }

    class MoveHost implements Step {
      readonly parallel = false
      constructor(
        readonly host: HostName,
        readonly context: string
      ) {}
      async run() {
        const req = newReq('host', this.toString())
        const current = (await als.run(req, () =>
          H.gated.getResource('hosts', this.host, HOSTS_NS)
        )) as { metadata: { resourceVersion?: string }; spec: Record<string, unknown> }
        await send(
          req,
          request(H.adminApp)
            .put(`/api/v1/admin/hosts/${this.host}`)
            .send({
              metadata: { resourceVersion: current.metadata.resourceVersion },
              spec: { ...current.spec, contextRef: this.context },
            })
        )
        if (req.status !== 200) violation(`${req.label}: host PUT answered ${req.status}`)
        H.model.accessWrites.push({ start: req.startSeq, end: H.seq })
      }
      toString() {
        return `MoveHost(${this.host},${this.context})`
      }
    }

    class Disconnect implements Step {
      readonly parallel = true
      constructor(
        readonly u: number,
        readonly context: string
      ) {}
      async run() {
        const req = newReq('disconnect', this.toString())
        await send(
          req,
          request(H.app)
            .delete('/api/v1/internal/mcp-oauth/grant')
            .set('Authorization', 'Bearer dev-rpc-proxy-token')
            .set('x-service-token', 'rpc-proxy')
            .send({ mcpServerName: SC, userId: users[this.u], contextId: this.context })
        )
        checkDisconnect(req, users[this.u], this.context)
      }
      toString() {
        return `Disconnect(${userLabel(this.u)},${this.context})`
      }
    }

    class Sweep implements Step {
      readonly parallel = true
      run() {
        return sweep()
      }
      toString() {
        return 'Sweep()'
      }
    }

    class Broker implements Step {
      constructor(
        readonly host: HostName,
        readonly parallel: boolean
      ) {}
      run() {
        return broker(this.host, this.toString())
      }
      toString() {
        return `${this.parallel ? 'Refresh' : 'Broker'}(${this.host})`
      }
    }

    class Release implements Step {
      readonly parallel = false
      async run() {
        const s = H.s
        if (s && s.count() > 0) await s.waitOne()
      }
      toString() {
        return 'Release()'
      }
    }

    const user = fc.integer({ min: 0, max: 2 })
    const context = fc.constantFrom(...CONTEXTS)
    const servers = fc.subarray([...SERVERS])
    // h1 is the Host of the Context the best-connected user consents in.
    const favouredHost = fc.constantFrom<HostName>('h1', 'h1', 'h2', 'h3')
    const step: fc.Arbitrary<Step> = fc.oneof(
      {
        weight: 4,
        arbitrary: fc
          .tuple(
            user,
            fc.constantFrom<string>(SC, SC, SU),
            fc.constantFrom<string | undefined>('c1', 'c2', 'c3', undefined, 'Not_A_Name')
          )
          .map(([u, s, c]) => new Mint(u, s, c)),
      },
      {
        weight: 6,
        arbitrary: fc
          .tuple(
            fc.constantFrom(0, 0, 1, 2),
            fc.constantFrom<string>(SC, SC, SC, SU),
            fc.constantFrom('c1', 'c1', 'c2', 'c3')
          )
          .map(([u, s, c]) => new Connect(u, s, c)),
      },
      { weight: 1, arbitrary: user.map(u => new MintLegacy(u)) },
      { weight: 2, arbitrary: user.map(u => new LegacyCallback(u)) },
      { weight: 4, arbitrary: fc.nat(20).map(i => new Callback(i, false)) },
      { weight: 1, arbitrary: fc.nat(20).map(i => new Callback(i, true)) },
      {
        weight: 3,
        arbitrary: fc
          .tuple(context, servers, fc.boolean())
          .map(([c, s, rv]) => new AdminPut(c, s, rv)),
      },
      { weight: 1, arbitrary: context.map(c => new AdminDelete(c)) },
      { weight: 1, arbitrary: fc.tuple(context, servers).map(([c, s]) => new Recreate(c, s)) },
      {
        // Mostly c3, which starts absent, and mostly with an alias: the Context
        // shape only a writer outside control-api can produce.
        weight: 2,
        arbitrary: fc
          .tuple(
            fc.constantFrom('c3', 'c3', 'c1', 'c2'),
            servers,
            fc.constantFrom(true, true, false)
          )
          .map(([c, s, alias]) => new ExternalCreate(c, s, alias)),
      },
      { weight: 1, arbitrary: fc.constant(new FailNextPurge()) },
      {
        weight: 2,
        arbitrary: fc
          .tuple(context, fc.constantFrom<string>(...SERVERS), fc.boolean())
          .map(([c, s, add]) => new External(c, s, add)),
      },
      { weight: 1, arbitrary: context.map(c => new ExternalDelete(c)) },
      {
        weight: 1,
        arbitrary: fc
          .tuple(user, fc.subarray([...CONTEXTS]))
          .map(([u, cs]) => new SetUserContexts(u, cs)),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(user, fc.subarray(HOST_NAMES))
          .map(([u, hs]) => new SetUserAgents(u, hs)),
      },
      {
        weight: 1,
        arbitrary: fc
          .tuple(fc.constantFrom(...HOST_NAMES), context)
          .map(([h, c]) => new MoveHost(h, c)),
      },
      {
        weight: 3,
        arbitrary: fc
          .tuple(fc.constantFrom(0, 0, 1, 2), fc.constantFrom('c1', 'c1', 'c2', 'c3'))
          .map(([u, c]) => new Disconnect(u, c)),
      },
      { weight: 3, arbitrary: fc.constant(new Sweep()) },
      {
        weight: 3,
        arbitrary: fc
          .constantFrom<'remove' | 'delete'>('remove', 'delete')
          .map(m => new SweepRace(m)),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(
            fc.constantFrom<'admin' | 'external'>('admin', 'admin', 'external'),
            fc.boolean(),
            fc.boolean()
          )
          .map(([via, fail, inFlight]) => new DeleteAndRecreate(via, fail, inFlight)),
      },
      { weight: 1, arbitrary: fc.constant(new WipeContexts()) },
      { weight: 1, arbitrary: servers.map(sv => new AliasedEdit(sv)) },
      {
        weight: 3,
        arbitrary: fc
          .constantFrom<'revoke' | 'purge'>('revoke', 'purge')
          .map(m => new RefreshRace(m)),
      },
      { weight: 2, arbitrary: favouredHost.map(h => new Broker(h, true)) },
      { weight: 3, arbitrary: favouredHost.map(h => new Broker(h, false)) },
      { weight: 4, arbitrary: fc.constant(new Release()) }
    )

    // ── run lifecycle ─────────────────────────────────────────────────────────

    beforeAll(async () => {
      if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
      dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
      await initDb({ connect: () => dbPool.connect() })
      rawDb = { query: (text, values) => dbPool.query(text, values) }
      testDb.query = gatedQuery as never
      testDb.txPool = txPool
      config.mcpOauthBrokerEnabled = true
      config.contextsNamespace = CTX_NS
      operator = await seedControlAdmin(rawDb)
      users = []
      for (let i = 0; i < 3; i++) users.push(await seedActiveMember(rawDb, {}))
    })

    const originalBrokerEnabled = config.mcpOauthBrokerEnabled
    const originalContextsNamespace = config.contextsNamespace
    afterAll(async () => {
      try {
        config.mcpOauthBrokerEnabled = originalBrokerEnabled
        config.contextsNamespace = originalContextsNamespace
        testDb.query = undefined
        testDb.txPool = undefined
        if (dbPool) await endPoolAndWaitForClients(dbPool)
        if (adminPool) {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [database]
          )
          await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
        }
      } finally {
        await adminPool?.end()
      }
    })

    function freshModel(): Model {
      return {
        contexts: new Map(),
        hosts: new Map(),
        userContexts: new Map(),
        userAgents: new Map(),
        rows: new Map(),
        clocks: new Map(),
        incarnations: new Map(),
        ctxWrites: [],
        grantWrites: [],
        grantDeletes: [],
        accessWrites: [],
      }
    }

    /**
     * Initial world, through production writers only: both servers installed with
     * no Context and enabled by the admin Context route, Hosts by the admin Host
     * route, memberships by the directory writers.
     */
    async function startRun(): Promise<void> {
      H.s = null
      H.seq = 0
      H.reqCounter = 0
      H.reqs = new Map()
      H.model = freshModel()
      H.violations = []
      H.failPurges = 0
      H.dbTail = Promise.resolve()
      H.mints = []
      H.usedStates = []
      H.incarnationJudged = 0
      H.panelMixed = false
      H.onCodeExchange = null
      H.background = []
      await dbPool.query('TRUNCATE oauth_grants, user_contexts, user_agents')

      H.gateway = new MockGateway(NS)
      H.gated = gatedGateway(H.gateway)
      H.app = withRequestRecord(createApp(H.gated as never) as express.Express)
      const admin = express()
      admin.use(express.json())
      admin.use((req, _res, next) => {
        ;(req as unknown as { adminAuth: { sub: string; role: string } }).adminAuth = {
          sub: operator,
          role: 'admin',
        }
        next()
      })
      admin.use('/api/v1', createAdminRouter(H.gated as never))
      admin.use(clerumErrorHandler)
      H.adminApp = withRequestRecord(admin)

      for (const [name, scope] of [
        [SC, 'context'],
        [SU, 'user'],
      ] as const) {
        await installServer(H.gateway, name, bakedOAuth('google', scope))
      }
      H.gateway.seedSecret('google-creds', NS, {
        data: {
          'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
          'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
        },
      })
      for (const [name, enabled] of [
        ['c1', [SC, SU]],
        ['c2', [SC]],
      ] as const) {
        await adminCall(
          request(H.adminApp)
            .post('/api/v1/admin/contexts')
            .send({ metadata: { name }, spec: { contextId: name, mcpServers: [] } }),
          201
        )
        const current = (await H.gateway.getResource('contexts', name, CTX_NS)) as {
          metadata: { resourceVersion?: string }
          spec: Record<string, unknown>
        }
        await adminCall(
          request(H.adminApp)
            .put(`/api/v1/admin/contexts/${name}`)
            .send({
              metadata: { resourceVersion: current.metadata.resourceVersion },
              spec: { ...current.spec, mcpServers: [...enabled] },
            }),
          200
        )
      }
      for (const host of HOST_NAMES) {
        await adminCall(
          request(H.adminApp)
            .post('/api/v1/admin/hosts')
            .send({
              metadata: { name: host },
              spec: { host, contextRef: HOSTS[host], secretRef: `${host}-llm` },
            }),
          201
        )
        H.hostTokens.set(host, await mintHccControlToken(H.app, H.gateway, host))
      }
      await setUserContexts(users[0], ['c1'], operator)
      // Two agents in two Contexts: a panel where a revoke in one Context must
      // not be masked by the grant of the other.
      await setUserAgents(users[1], ['h1', 'h2'], operator)
      H.model.userContexts.set(users[0], ['c1'])
      H.model.userAgents.set(users[1], ['h1', 'h2'])
      // One consent per Context, by a direct member and by a member through an
      // agent's Host, through the same mint and callback the commands use.
      for (const [u, ctx] of [
        [0, 'c1'],
        [1, 'c2'],
      ] as const) {
        const { req, res } = await mint(users[u], SC, ctx)
        checkMint(req, SC, ctx)
        if (res.status !== 200) continue
        const state = new URL(res.body.authorizeUrl as string).searchParams.get('state') ?? ''
        await callback(
          { state, claims: { server: SC, user: users[u], context: ctx, legacy: false } },
          `setup consent ${ctx}`
        )
      }
      // With nothing concurrent, a member's consent must end in a grant its Hosts are served.
      for (const [host, ctx] of [
        ['h1', 'c1'],
        ['h2', 'c2'],
      ] as const) {
        if (!H.model.rows.has(sharedKey(SC, ctx))) {
          violation(`setup: an uncontested consent in ${ctx} left no grant`)
        }
        await broker(host, `setup broker ${host}`)
      }
      if (H.violations.length > 0) return
      // The world above is the starting point, not something the checks judge.
      H.model.ctxWrites = []
      H.model.grantWrites = []
      H.reqs = new Map()
    }

    /** A connector rail as rpc-proxy reads it for the signed-in user. */
    async function rpcAccess(userId: string, rail: 'mcp-servers' | 'mcp-connectors') {
      const issued = issueRpcAccessToken(
        { userId, teamId: null, role: 'member' },
        ['mcp:servers:list'],
        HOST_NAMES
      )
      if (!issued) throw new Error('rpc access token not issued')
      const token = issued.token
      const res = await request(H.app)
        .get(`/api/v1/rpc/access/users/${userId}/${rail}`)
        .set('Authorization', 'Bearer dev-rpc-proxy-token')
        .set('x-service-token', 'rpc-proxy')
        .set('x-rpc-access-token', token)
      if (res.status !== 200) throw new Error(`${rail} ${res.status} ${res.text}`)
      return res.body as Record<string, unknown>
    }

    async function checkAtRest(): Promise<void> {
      const m = H.model
      const real = await dbPool.query(
        `SELECT grant_kind, recipe_name, context_id, user_id::text AS user_id,
              bootstrapped_by_user_id::text AS bootstrapped_by
         FROM oauth_grants`
      )
      const realRows = (
        real.rows as Array<{
          grant_kind: string
          recipe_name: string
          context_id: string | null
          user_id: string | null
          bootstrapped_by: string | null
        }>
      )
        .map(r =>
          r.grant_kind === 'shared'
            ? `shared|${r.recipe_name}|${r.context_id}|${r.bootstrapped_by}`
            : `${r.grant_kind}|${r.recipe_name}|${r.user_id}`
        )
        .sort()
      const modelRows = [...m.rows.values()]
        .map(r =>
          r.kind === 'shared'
            ? `shared|${r.server}|${r.owner}|${r.bootstrappedBy}`
            : `user|${r.server}|${r.owner}`
        )
        .sort()
      if (JSON.stringify(realRows) !== JSON.stringify(modelRows)) {
        violation(
          `at rest: oauth_grants ${JSON.stringify(realRows)} ≠ model ${JSON.stringify(modelRows)}`
        )
      }

      for (const row of m.rows.values()) {
        if (row.kind !== 'shared') continue
        const ctx = m.contexts.get(row.owner)
        if (
          ctx &&
          row.c5Uid &&
          row.c5Uid !== ctx.uid &&
          !incarnationMismatchAllowed(ctx.uid, row.insertSeq)
        ) {
          violation(`at rest: ${row.server}/${row.owner} was consented for an earlier incarnation`)
        }
      }

      const live = (c: string) => m.contexts.get(c)
      const hasRow = (server: string, owner: string, kind: 'shared' | 'user') =>
        m.rows.has(kind === 'shared' ? sharedKey(server, owner) : userKey(server, owner))

      for (const userId of users) {
        const agents = m.userAgents.get(userId) ?? []
        const contexts = m.userContexts.get(userId) ?? []
        const panel = (await rpcAccess(userId, 'mcp-connectors')).agents as Array<{
          name: string
          connectors: Array<{ name: string; status: string }>
        }>
        for (const agent of panel) {
          const ctxName = m.hosts.get(agent.name) ?? ''
          const ctx = live(ctxName)
          if (
            ctx?.servers.has(SC) &&
            !hasRow(SC, ctxName, 'shared') &&
            [...m.rows.values()].some(r => r.kind === 'shared' && r.server === SC)
          ) {
            H.panelMixed = true
          }
          for (const server of SERVERS) {
            const entry = agent.connectors.find(c => c.name === server)
            const enabled = !!ctx && ctx.servers.has(server)
            if (!!entry !== enabled) {
              violation(
                `at rest: panel of ${agent.name} lists ${server}: ${!!entry}, enabled: ${enabled}`
              )
              continue
            }
            if (!entry) continue
            const granted =
              server === SC ? hasRow(SC, ctxName, 'shared') : hasRow(SU, userId, 'user')
            if ((entry.status === 'authorized') !== granted) {
              violation(
                `at rest: panel of ${agent.name} shows ${server} ${entry.status}, grant present: ${granted}`
              )
            }
            if (server === SC && entry.status === 'requires_setup') {
              const { req } = await mint(userId, SC, ctxName)
              if (req.status === 403) {
                violation(`at rest: panel offers ${SC} in ${ctxName} but the mint refuses`)
              }
            }
          }
        }
        const rail = (await rpcAccess(userId, 'mcp-servers')).servers as Array<{ name: string }>
        for (const server of SERVERS) {
          const listed = rail.some(s => s.name === server)
          const expected = contexts.some(c => {
            const ctx = live(c)
            if (!ctx || !ctx.servers.has(server)) return false
            return server === SC ? hasRow(SC, c, 'shared') : hasRow(SU, userId, 'user')
          })
          if (listed !== expected) {
            violation(
              `at rest: flat catalog of ${userLabel(users.indexOf(userId))} lists ${server}: ${listed}, expected ${expected}`
            )
          }
        }
      }
    }

    /**
     * What the runs actually reached. A generator that never got a consent through,
     * never purged a row or never refreshed would pass every invariant vacuously.
     */
    const coverage: Record<string, number> = {}
    function tallyCoverage(): void {
      const bump = (key: string, n = 1) => {
        if (n > 0) coverage[key] = (coverage[key] ?? 0) + n
      }
      for (const r of H.reqs.values()) {
        if (r.kind === 'callback' && r.claims?.legacy) bump('outdated state refused')
        else if (r.kind === 'callback' && r.claims?.server === SC) {
          bump(r.status === 200 ? 'shared consent completed' : 'shared consent refused')
        } else if (r.kind === 'callback' && r.status === 200) bump('user consent completed')
        if (r.kind === 'broker' && r.status === 200) bump('broker served')
        if (r.kind === 'broker' && r.status !== 200) bump('broker refused')
        if (r.kind === 'disconnect' && r.status === 204) bump('member revoked')
        if (
          r.kind === 'disconnect' &&
          r.status === 204 &&
          r.ctxReads.some(c => c.found && !c.servers.has(SC))
        ) {
          bump('member revoked where the Context no longer enables the server')
        }
        if (r.kind === 'put' && r.aliasResent) bump('admin PUT resending an alias')
        if (r.kind === 'sweep' && r.listedLive === 0) bump('sweep on an empty Context list')
        if (r.hookFailed) bump('purge hook failed')
        for (const st of r.statements) {
          bump('sweep spared a row written after its clock', st.fencedOut ?? 0)
          bump('create purged an earlier incarnation', st.earlierIncarnationPurged ?? 0)
          if (!st.deleted?.length) continue
          bump(r.kind === 'sweep' ? 'sweep purged rows' : 'route hook purged rows')
        }
      }
      bump('a row of an earlier incarnation was judged', H.incarnationJudged)
      if (H.panelMixed) bump('panel showed a Context without its grant next to one with it')
      for (const r of H.reqs.values()) {
        if (r.kind === 'broker' && r.grantReads[0]?.length && r.lockReads.includes(false)) {
          bump('broker found the grant gone under its lock')
        }
      }
      bump('refresh committed', H.model.grantWrites.filter(w => w.refresh).length)
    }

    it('every interleaving keeps grants consented, scoped, purged and served as the model says', async () => {
      let idp = 0
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input) !== TOKEN_ENDPOINT) throw new Error(`unexpected fetch ${String(input)}`)
        const grantType = new URLSearchParams(String(init?.body ?? '')).get('grant_type') ?? '?'
        als.getStore()?.idpPosts.push(grantType)
        if (grantType === 'authorization_code') H.onCodeExchange?.()
        await gate(`idp:${grantType}`)
        idp += 1
        return Response.json({
          access_token: `AT-${idp}`,
          refresh_token: `RT-${idp}`,
          expires_in: TOKEN_TTL_SECONDS,
        })
      })
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.scheduler(),
            fc.commands([step], { maxCommands: 12 }),
            async (s, cmds) => {
              await startRun()
              if (H.violations.length > 0) {
                throw new Error(['violations:', ...H.violations.map(v => `  - ${v}`)].join('\n'))
              }
              H.s = s
              const pending: Promise<void>[] = []
              const launch = (st: Step) =>
                st.run().catch(err => {
                  violation(`${st.toString()} threw: ${(err as Error).stack ?? String(err)}`)
                })
              try {
                await fc.asyncModelRun(
                  () => ({ model: {}, real: {} }),
                  [...cmds].map(cmd => {
                    const st = cmd as unknown as Step
                    return {
                      check: () => true,
                      run: async () => {
                        if (st instanceof Release) await st.run()
                        else if (st.parallel) pending.push(launch(st))
                        else await s.waitFor(launch(st))
                      },
                      toString: () => st.toString(),
                    }
                  })
                )
                await s.waitFor(Promise.allSettled([...pending, ...H.background]))
                await s.waitIdle()
                if (s.count() > 0) violation(`${s.count()} scheduled tasks never settled`)
              } finally {
                H.s = null
              }
              await H.dbTail
              await checkAtRest()
              tallyCoverage()
              if (H.violations.length > 0) {
                const order = s
                  .report()
                  .filter(t => t.status !== 'pending')
                  .map(t => t.label)
                throw new Error(
                  [
                    'violations:',
                    ...H.violations.map(v => `  - ${v}`),
                    `commands: ${[...cmds].map(c => String(c)).join(' ; ')}`,
                    `scheduler order (${order.length}):`,
                    ...order.map((label, i) => `  ${i + 1}. ${label}`),
                  ].join('\n')
                )
              }
            }
          ),
          { numRuns: NUM_RUNS, seed: SEED, endOnFailure: true }
        )
      } finally {
        fetchSpy.mockRestore()
      }
      for (const reached of [
        'shared consent completed',
        'shared consent refused',
        'outdated state refused',
        'user consent completed',
        'broker served',
        'broker refused',
        'member revoked',
        'purge hook failed',
        'route hook purged rows',
        'sweep purged rows',
        'refresh committed',
        'sweep spared a row written after its clock',
        'sweep on an empty Context list',
        'a row of an earlier incarnation was judged',
        'create purged an earlier incarnation',
        'panel showed a Context without its grant next to one with it',
        'broker found the grant gone under its lock',
        'admin PUT resending an alias',
      ]) {
        expect(
          coverage[reached] ?? 0,
          `runs never reached: ${reached} (reached: ${JSON.stringify(coverage)})`
        ).toBeGreaterThan(0)
      }
    }, 180_000)
  }
)
