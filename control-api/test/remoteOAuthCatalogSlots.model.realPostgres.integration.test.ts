/**
 * Model-based check of remote-OAuth catalog slots: random sequences of catalog
 * installs (CIMD, pre-registered and DCR, honest or with a tampered body),
 * uninstalls through the generic DELETE and through the registry route, catalog
 * reads, Context allowlist edits from fresh or stale snapshots, generic McpServer
 * edits and forged creates, and consents. Every await of the code under test that
 * touches shared state is a point the fast-check scheduler orders, so each run
 * explores one interleaving of the commands launched concurrently.
 *
 * Layers:
 *   - Postgres is real. Every `pool.query` waits on the scheduler, then runs alone
 *     and in release order. Transactions are not gated: one that waited on the
 *     scheduler while holding row locks could deadlock against Postgres.
 *   - McpServers and Contexts live in an in-memory apiserver driven through the
 *     real `ResourceService` (uids, resourceVersions, replace and delete
 *     preconditions). Secrets live in `MockGateway`. Every call waits on the
 *     scheduler first.
 *   - The authorization server is a double: discovery returns results the real
 *     discovery client produced over recorded probes, registration (DCR) and RFC
 *     7592 deletes answer after a scheduler gate. The registry client is a double
 *     serving rows built by `registryEntryRow`.
 *   - Routes, the install saga, `uninstallMcpServer`, the Context ratchet and the
 *     catalog-instance guard are the production code.
 *
 * The reference model is trivial: the CRs the 201 installs created minus the ones
 * an uninstall deleted, the consents and the Context writes. At rest it is compared
 * with the apiserver, the catalog read, the OAuth tables and the Secrets.
 *
 * The only dangling allowlist entry accepted is the one an edit adds while an
 * uninstall of that name sits between its allowlist strip and its CR delete: the
 * CR is still alive when the edit checks it, and the strip has already passed.
 * Any other name without a live CR in an allowlist fails the run.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/remoteOAuthCatalogSlots.model.realPostgres.integration.test.ts
 *
 * `FC_SEED=<n>` replays another seed, `FC_NUM_RUNS=<n>` changes the number of runs
 * and `FC_MAX_COMMANDS=<n>` the length of each sequence. A failure prints the
 * command sequence, the scheduler's release order and the violated invariants.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fc from 'fast-check'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Pool, type QueryResult } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { initDb, withTransaction } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import { type OAuthGrantKey, getOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'
import { deriveCatalogRemoteServerName } from '../src/routes/admin/catalogRemoteOAuth.js'
import { catalogAnnotations, createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import {
  buildRemoteMcpServerResource,
  buildRemoteOAuthSpec,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { fakeCustomObjectsApiserver } from './fixtures/fakeCustomObjectsApiserver.js'
import { discoverPilot, withRfc9207 } from './fixtures/perServerInstall.js'
import { registryEntryRow } from './fixtures/registryEntryRow.js'
import {
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  PILOTS,
  dcrPilot,
  makeDcrTransport,
} from './fixtures/remoteOAuthDiscovery.js'
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

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

/** The authorization server double, shared by the install saga and the uninstall. */
const asDouble = vi.hoisted(() => ({
  transport: undefined as undefined | ((req: unknown) => Promise<unknown>),
}))

// The uninstall revokes a DCR client over the default pinned transport; with no
// transport injectable there, the default is replaced by the double so no request
// leaves the process.
vi.mock('../src/http/pinnedFetch.js', async importActual => {
  const actual = await importActual<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: Record<string, unknown> = {}) =>
      actual.pinnedFetch(url, field, {
        ...options,
        transport: options.transport ?? asDouble.transport,
      } as never),
  }
})

const registryDouble = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  latest: [] as Record<string, unknown>[],
}))

vi.mock('../src/services/registryClient.js', async importActual => {
  const actual = await importActual<typeof import('../src/services/registryClient.js')>()
  return {
    ...actual,
    // The registry resolves an unscoped name to its curated scope, as an alias.
    getEntryVersion: async (name: string, version: string) => {
      const resolved = name.startsWith('@') ? name : `@evenfire/${name}`
      const row = registryDouble.rows.get(`${resolved}@${version}`)
      if (!row) throw Object.assign(new Error('entry not found'), { status: 404 })
      return structuredClone(row)
    },
    searchEntries: async () => ({
      data: structuredClone(registryDouble.latest),
      meta: { total: registryDouble.latest.length, limit: 200, offset: 0 },
    }),
    getCategories: async () => ({ data: [] }),
    getDigest: async () => ({ digest: null }),
    getCredentialSchema: async () => {
      throw new Error('No credential schema endpoint')
    },
    reportInstall: async () => ({ acknowledged: true, stored: true }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const NS = config.mcpServersNamespace
// Contexts apart from the McpServers, as a deployment may place them: a strip or a
// ratchet that mixes the two namespaces shows.
const CTX_NS = 'oracle-contexts'
const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const PUBLIC_IP = async () => ['93.184.216.34']
const NOTION_URL = PILOTS.notion.mcpUrl
const LINEAR_URL = PILOTS.linear.mcpUrl
const EVIL_URL = 'https://evil.example.com/mcp'
const PLAIN = 'plain-server'
const GHOST = 'ghost-server'
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261030
const NUM_RUNS = process.env.FC_NUM_RUNS ? Number(process.env.FC_NUM_RUNS) : 300
const MAX_COMMANDS = process.env.FC_MAX_COMMANDS ? Number(process.env.FC_MAX_COMMANDS) : 20

type Scope = 'user' | 'context'
type Mode = 'cimd' | 'pre-registered' | 'dcr'

interface EntryDef {
  key: 'A' | 'B' | 'C'
  name: string
  versions: string[]
  url: string
  scopes: Scope[]
  modes: Mode[]
  expectedRegistration: Mode
}

const ENTRIES: EntryDef[] = [
  {
    key: 'A',
    name: '@evenfire/notion-remote',
    versions: ['1.0.0', '1.1.0'],
    url: NOTION_URL,
    scopes: ['user', 'context'],
    modes: ['cimd', 'pre-registered'],
    expectedRegistration: 'cimd',
  },
  {
    key: 'B',
    name: '@evenfire/notion-dcr',
    versions: ['1.0.0'],
    url: NOTION_URL,
    scopes: ['user', 'context'],
    modes: ['dcr'],
    expectedRegistration: 'dcr',
  },
  {
    // Only the user slot exists: a context install must be refused.
    key: 'C',
    name: '@evenfire/linear-remote',
    versions: ['1.0.0'],
    url: LINEAR_URL,
    scopes: ['user'],
    modes: [],
    expectedRegistration: 'cimd',
  },
]
const ENTRY = Object.fromEntries(ENTRIES.map(e => [e.key, e])) as Record<EntryDef['key'], EntryDef>

interface Slot {
  entry: EntryDef
  scope: Scope
}
const label = (slot: Slot) => `${slot.entry.key}-${slot.scope[0]}`
const canonical = (slot: Slot) => deriveCatalogRemoteServerName(slot.entry.name, slot.scope)
const SLOTS: Slot[] = ENTRIES.flatMap(entry =>
  (['user', 'context'] as const).map(scope => ({ entry, scope }))
)
const INSTALLABLE = SLOTS.filter(s => s.entry.scopes.includes(s.scope))
const CONTEXTS = ['c1', 'c2', 'c3'] as const

// ── observation records ─────────────────────────────────────────────────────

type ReqKind =
  | 'install'
  | 'uninstall'
  | 'catalog'
  | 'ctxRead'
  | 'ctxEdit'
  | 'ctxCreate'
  | 'serverRead'
  | 'serverEdit'
  | 'forge'
  | 'consent'

interface CtxWrite {
  ctx: string
  before: string[]
  after: string[]
  seq: number
  /** McpServer names alive just before the write. */
  liveAtWrite: Set<string>
}

interface Req {
  id: string
  kind: ReqKind
  label: string
  status?: number
  body?: Record<string, unknown>
  slot?: Slot
  entry?: EntryDef
  mcpReads: Array<{ name: string; uid?: string; seq: number }>
  crCreates: Array<{ name: string; uid: string; seq: number }>
  crDeletes: Array<{ name: string; uid: string; seq: number }>
  ctxLists: number[]
  ctxWrites: CtxWrite[]
  secretCreates: Array<{ name: string; uid: string }>
  secretDeletes: Array<{ name: string; uid?: string }>
  /** Binds of a pending dynamic client to a CR uid that took effect. */
  dcrBinds: Array<{ name: string; uid: string; seq: number }>
  /** Teardown claim-deletes of the dynamic client bound to a CR uid. */
  dcrClaims: Array<{ name: string; uid: string; seq: number }>
  /** Client registrations this request made at the authorization server. */
  asRegistrations: number
}

interface ConsentRecord {
  user: string
  name: string
  uid: string
  seq: number
}

interface Snapshot {
  rv: string
  spec: Record<string, unknown>
  metadata: Record<string, unknown>
}

type StoredObj = {
  metadata: {
    name: string
    uid: string
    resourceVersion?: string
    annotations?: Record<string, string>
  }
  spec: Record<string, unknown> & {
    mcpServers?: string[]
    remote?: { baseUrl?: string }
    transport?: { url?: string }
    egressBindings?: Array<{ dns?: string }>
    oauth?: Record<string, unknown> & { grantScope?: string; source?: string; scopes?: string[] }
  }
}

describeRealPostgres('remote-OAuth catalog slots against a reference model (real Postgres)', () => {
  const database = `control_api_catalog_slots_model_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let rawDb: DbClient
  const discovery = new Map<EntryDef['key'], DiscoveryResult>()
  let cimdResult: DiscoveryResult
  const als = new AsyncLocalStorage<Req>()

  const H = {
    s: null as fc.Scheduler | null,
    seq: 0,
    reqCounter: 0,
    reqs: [] as Req[],
    violations: [] as string[],
    dbTail: Promise.resolve() as Promise<unknown>,
    consents: [] as ConsentRecord[],
    dialogs: new Map<string, Snapshot>(),
    serverSnaps: new Map<string, Snapshot>(),
    dcrCounter: 0,
    /** Commands running, and gates they are parked at. */
    active: 0,
    parked: 0,
    api: undefined as unknown as ReturnType<typeof fakeCustomObjectsApiserver>,
    secrets: undefined as unknown as MockGateway,
    app: undefined as unknown as express.Express,
  }
  const coverage: Record<string, number> = {}
  const bump = (what: string, n = 1) => {
    if (n > 0) coverage[what] = (coverage[what] ?? 0) + n
  }
  const violation = (message: string) => H.violations.push(message)

  // ── scheduler gates ───────────────────────────────────────────────────────

  async function gate(what: string): Promise<void> {
    const s = H.s
    if (!s) return
    H.parked += 1
    try {
      await s.schedule(Promise.resolve(), what)
    } finally {
      H.parked -= 1
    }
  }

  /**
   * Waits until every running command is parked at a gate (or a short deadline
   * passes). Requests travel over real sockets and real Postgres; releasing a gate
   * while the others are still on the wire would let one command run ahead alone,
   * and the scheduler would only ever see one candidate.
   */
  async function quiesce(): Promise<void> {
    const deadline = Date.now() + 250
    while (H.parked < H.active && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }

  /** Releases scheduled gates, one at a time and each among all parked ones, until `p` settles. */
  async function drain(s: fc.Scheduler, p: Promise<unknown>): Promise<void> {
    let done = false
    void p.finally(() => {
      done = true
    })
    while (!done) {
      await quiesce()
      if (done) break
      if (s.count() > 0) await s.waitOne()
      else await new Promise(resolve => setTimeout(resolve, 1))
    }
  }

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = H.dbTail.then(work)
    H.dbTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function gatedQuery(text: string, values?: unknown[]): Promise<QueryResult> {
    const rec = als.getStore()
    await gate(`db:${text.replace(/\s+/g, ' ').trim().slice(0, 48)}`)
    return serialized(async () => {
      const result = await dbPool.query(text, values)
      const seq = ++H.seq
      const v = (values ?? []) as string[]
      if (rec && /UPDATE dynamic_clients\s+SET cr_uid = \$5/.test(text) && result.rowCount) {
        rec.dcrBinds.push({ name: v[2], uid: v[4], seq })
      }
      if (rec && /DELETE FROM dynamic_clients[\s\S]*cr_uid = \$4 OR/.test(text)) {
        rec.dcrClaims.push({ name: v[2], uid: v[3], seq })
      }
      return result
    })
  }
  const gatedDb: DbClient = { query: (text, values) => gatedQuery(text, values as unknown[]) }

  const txPool = { connect: () => dbPool.connect() }

  // ── apiserver and Secrets, gated and observed ─────────────────────────────

  const allowlist = (obj: StoredObj | undefined) => [...(obj?.spec?.mcpServers ?? [])]

  function liveUid(name: string): string | undefined {
    return (H.api.peek('mcpservers', NS, name) as StoredObj | undefined)?.metadata.uid
  }

  function liveServerNames(): Set<string> {
    return new Set(
      [...H.api.store.entries()]
        .filter(([k]) => k.startsWith(`mcpservers/${NS}/`))
        .map(([, v]) => (v as StoredObj).metadata.name)
    )
  }

  function instrumentApiserver(api: ReturnType<typeof fakeCustomObjectsApiserver>) {
    type Args = { plural: string; namespace: string; name?: string; body?: unknown }
    const methods = api.customApi as unknown as Record<string, (args: Args) => Promise<unknown>>
    const verbs: Array<[string, string]> = [
      ['getNamespacedCustomObject', 'get'],
      ['listNamespacedCustomObject', 'list'],
      ['createNamespacedCustomObject', 'create'],
      ['replaceNamespacedCustomObject', 'replace'],
      ['deleteNamespacedCustomObject', 'delete'],
    ]
    for (const [method, verb] of verbs) {
      const original = methods[method]
      methods[method] = async (args: Args) => {
        const rec = als.getStore()
        const name = args.name ?? (args.body as StoredObj | undefined)?.metadata?.name
        await gate(`k8s.${verb}:${args.plural}/${name ?? '*'}`)
        const before =
          name !== undefined
            ? (api.peek(args.plural, args.namespace, name) as StoredObj | undefined)
            : undefined
        const liveAtWrite = args.plural === 'contexts' ? liveServerNames() : new Set<string>()
        let out: unknown
        try {
          out = await original(args)
        } catch (err) {
          if (rec && verb === 'get' && args.plural === 'mcpservers' && name) {
            rec.mcpReads.push({ name, seq: ++H.seq })
          }
          throw err
        }
        const seq = ++H.seq
        if (!rec) return out
        const obj = out as StoredObj
        if (args.plural === 'mcpservers') {
          if (verb === 'get' && name) rec.mcpReads.push({ name, uid: obj.metadata.uid, seq })
          if (verb === 'create' && name) rec.crCreates.push({ name, uid: obj.metadata.uid, seq })
          if (verb === 'delete' && name && before) {
            rec.crDeletes.push({ name, uid: before.metadata.uid, seq })
          }
        }
        if (args.plural === 'contexts') {
          if (verb === 'list') rec.ctxLists.push(seq)
          if ((verb === 'replace' || verb === 'create') && name) {
            rec.ctxWrites.push({
              ctx: name,
              before: allowlist(before),
              after: allowlist(obj),
              seq,
              liveAtWrite,
            })
          }
        }
        return out
      }
    }
  }

  function gatedSecrets(gw: MockGateway): MockGateway {
    return new Proxy(gw, {
      get(target, prop) {
        if (prop === 'getSecret') {
          return async (name: string, ns?: string) => {
            await gate(`secret.get:${name}`)
            return target.getSecret(name, ns)
          }
        }
        if (prop === 'createSecret') {
          return async (req: unknown, opts?: unknown) => {
            const name = (req as { name?: string }).name ?? '?'
            await gate(`secret.create:${name}`)
            const out = await target.createSecret(req, opts as never)
            als.getStore()?.secretCreates.push({ name, uid: out.uid as string })
            return out
          }
        }
        if (prop === 'deleteSecret') {
          return async (name: string, ns?: string, pre?: { uid?: string }) => {
            await gate(`secret.delete:${name}`)
            const out = await target.deleteSecret(name, ns, pre as never)
            als.getStore()?.secretDeletes.push({ name, uid: pre?.uid })
            return out
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  function compositeGateway(): K8sGateway {
    const crs = H.api.gateway as unknown as Record<string, unknown>
    const secrets = gatedSecrets(H.secrets) as unknown as Record<string, unknown>
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          // Only McpServers and Contexts are modelled; the catalog read also lists
          // recipes and hooks, which no command writes.
          if (prop === 'listResource') {
            return (plural: string, ns?: string) =>
              plural === 'mcpservers' || plural === 'contexts'
                ? (crs.listResource as (p: string, n?: string) => Promise<unknown>)(plural, ns)
                : Promise.resolve([])
          }
          if (prop in crs) return crs[prop]
          return secrets[prop]
        },
      }
    ) as K8sGateway
  }

  // ── authorization server double ───────────────────────────────────────────

  const asTransport: PinnedTransport = async req => {
    if (req.method === 'POST' && /\/register$/.test(req.url)) {
      await gate('as.register')
      const clientId = `dyn-${++H.dcrCounter}`
      const rec = als.getStore()
      if (rec) rec.asRegistrations += 1
      const { transport } = makeDcrTransport({
        registrationEndpoint: req.url,
        responseJson: JSON.stringify({
          ...DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
          client_id: clientId,
          registration_client_uri: `${req.url}/${clientId}`,
        }),
        redirectUris: 'requested',
      })
      return transport(req)
    }
    if (req.method === 'DELETE') {
      await gate('as.revoke')
      return { status: 204, headers: {}, bodyText: '' }
    }
    return { status: 404, headers: {}, bodyText: 'unexpected url' }
  }

  const ALIVE: PinnedTransport = async ({ method }) =>
    method === 'POST'
      ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' }, bodyText: '' }
      : { status: 404, headers: {}, bodyText: '' }

  // ── requests ──────────────────────────────────────────────────────────────

  function newReq(kind: ReqKind, text: string, extra: Partial<Req> = {}): Req {
    const id = `r${++H.reqCounter}`
    const rec: Req = {
      id,
      kind,
      label: `${text}#${id}`,
      mcpReads: [],
      crCreates: [],
      crDeletes: [],
      ctxLists: [],
      ctxWrites: [],
      secretCreates: [],
      secretDeletes: [],
      dcrBinds: [],
      dcrClaims: [],
      asRegistrations: 0,
      ...extra,
    }
    H.reqs.push(rec)
    return rec
  }

  async function send(rec: Req, test: request.Test): Promise<request.Response> {
    const res = await test.set('x-oracle-req', rec.id)
    rec.status = res.status
    rec.body = res.body as Record<string, unknown>
    return res
  }

  function expectOutcome(rec: Req, allowed: Array<[number, string | undefined]>) {
    const error = typeof rec.body?.error === 'string' ? rec.body.error : undefined
    const ok = allowed.some(
      ([status, code]) => rec.status === status && (code === undefined || code === error)
    )
    if (!ok) {
      violation(
        `${rec.label}: unexpected ${rec.status} ${JSON.stringify(rec.body)?.slice(0, 300)}; ` +
          `allowed ${allowed.map(([s, c]) => `${s}${c ? ` ${c}` : ''}`).join(' | ')}`
      )
    }
    bump(`${rec.kind} ${rec.status}${error && rec.status !== 404 ? ` ${error}` : ''}`)
  }

  function buildApp(gateway: K8sGateway): express.Express {
    const inner = express()
    inner.use(express.json())
    inner.use(
      createAdminRemoteMcpRouter(gateway, {
        db: gatedDb,
        discover: async () => {
          const entry = als.getStore()?.entry
          await gate('as.discover')
          const result = entry ? discovery.get(entry.key) : undefined
          if (!result) throw new Error('discovery double: request without an entry')
          return { ok: true, result }
        },
        probe: (url, deps, opts) =>
          probeMcpTransport(url, { ...deps, transport: ALIVE, resolveDns: PUBLIC_IP }, opts),
        dcr: { transport: asTransport, resolveDns: PUBLIC_IP },
        runInTransaction: <T>(work: (tx: DbTransactionClient) => Promise<T>) =>
          withTransaction(work),
      })
    )
    inner.use(createAdminRegistryRouter(gateway))
    inner.use(createAdminResourcesRouter(gateway))
    inner.use(clerumErrorHandler)
    const outer = express()
    outer.use(express.json())
    outer.use((req, _res, next) => {
      const id = req.header('x-oracle-req')
      const rec = id ? H.reqs.find(r => r.id === id) : undefined
      if (rec) als.run(rec, next)
      else next()
    })
    outer.use(inner)
    return outer
  }

  async function readSnapshot(
    kind: 'ctxRead' | 'serverRead',
    name: string
  ): Promise<Snapshot | undefined> {
    const path = kind === 'ctxRead' ? '/admin/contexts' : '/admin/mcp-servers'
    const rec = newReq(kind, `Read(${name})`)
    const res = await send(rec, request(H.app).get(path))
    if (res.status !== 200) {
      violation(`${rec.label}: list answered ${res.status}`)
      return undefined
    }
    const item = (res.body.items as StoredObj[]).find(i => i.metadata.name === name)
    if (!item) return undefined
    return {
      rv: item.metadata.resourceVersion ?? '',
      spec: structuredClone(item.spec),
      metadata: structuredClone(item.metadata) as unknown as Record<string, unknown>,
    }
  }

  // ── commands ──────────────────────────────────────────────────────────────

  interface Step {
    readonly parallel: boolean
    run(): Promise<void>
    toString(): string
  }

  type Tamper = 'none' | 'trailingSlash' | 'evilUrl' | 'serverName' | 'alias'

  class Install implements Step {
    constructor(
      readonly slot: Slot,
      readonly version: string,
      readonly mode: Mode,
      readonly tamper: Tamper,
      readonly clientId: string,
      readonly parallel: boolean
    ) {}
    async run() {
      const { entry, scope } = this.slot
      const rec = newReq('install', this.toString(), { slot: this.slot, entry })
      const body: Record<string, unknown> = {
        catalogEntry: {
          name: this.tamper === 'alias' ? entry.name.replace(/^@evenfire\//, '') : entry.name,
          version: this.version,
        },
        grantScope: scope,
        mode: this.mode,
      }
      if (this.mode === 'pre-registered') {
        body.clientId = this.clientId
        body.clientSecret = `${this.clientId}-secret`
      }
      if (this.tamper === 'trailingSlash') body.baseUrl = `${entry.url}/`
      if (this.tamper === 'evilUrl') body.baseUrl = EVIL_URL
      if (this.tamper === 'serverName') body.serverName = 'my-own-name'
      const uidBefore = liveUid(canonical(this.slot))
      await send(rec, request(H.app).post('/admin/mcp-servers/remote').send(body))
      // A slot held by the same CR for the whole request cannot be installed, so the
      // request must not have minted a client at the AS nor written a client Secret
      // for it. Uids are never reused: an unchanged uid means no uninstall freed it.
      if (uidBefore && liveUid(canonical(this.slot)) === uidBefore) {
        if (rec.asRegistrations > 0 || rec.secretCreates.length > 0) {
          violation(
            `${rec.label}: the slot was installed throughout, yet the request registered ` +
              `${rec.asRegistrations} client(s) and created ${rec.secretCreates.length} Secret(s)`
          )
        }
        bump('install on a slot held throughout')
      }
      // The order the route checks a catalog body in.
      if (this.tamper === 'serverName') {
        expectOutcome(rec, [[400, 'catalog_server_name_not_allowed']])
      } else if (this.tamper === 'alias') {
        expectOutcome(rec, [[400, 'catalog_entry_name_mismatch']])
      } else if (!entry.scopes.includes(scope)) {
        expectOutcome(rec, [[400, 'catalog_grant_scope_not_allowed']])
      } else if (this.tamper === 'evilUrl') {
        expectOutcome(rec, [[400, 'catalog_base_url_mismatch']])
      } else {
        expectOutcome(rec, [
          [201, undefined],
          [409, 'server_name_in_use'],
          [409, 'install_in_progress'],
          [409, 'oauth_client_id_in_use'],
        ])
        if (rec.status === 201 && rec.body?.serverName !== canonical(this.slot)) {
          violation(`${rec.label}: installed as ${String(rec.body?.serverName)}`)
        }
      }
    }
    toString() {
      return `Install(${label(this.slot)},${this.version},${this.mode},${this.tamper}${
        this.mode === 'pre-registered' ? `,${this.clientId}` : ''
      }${this.parallel ? ',par' : ''})`
    }
  }

  class Uninstall implements Step {
    constructor(
      readonly slot: Slot,
      readonly via: 'generic' | 'registry',
      readonly parallel: boolean
    ) {}
    async run() {
      const rec = newReq('uninstall', this.toString(), { slot: this.slot })
      const name = canonical(this.slot)
      const path =
        this.via === 'generic' ? `/admin/mcp-servers/${name}` : `/admin/registry/uninstall/${name}`
      await send(rec, request(H.app).delete(path))
      if (this.via === 'generic') {
        expectOutcome(rec, [
          [200, undefined],
          [404, undefined],
          [503, 'mcp_server_uninstall_incomplete'],
        ])
      } else {
        expectOutcome(rec, [
          [200, undefined],
          [503, 'registry_uninstall_outcome_ambiguous'],
          [503, 'registry_uninstall_partial'],
        ])
      }
      const deletedHere = rec.crDeletes.length > 0
      const reportedNotFound =
        rec.status === 404 ||
        (rec.status === 200 &&
          Array.isArray(rec.body?.warnings) &&
          (rec.body.warnings as string[]).some(w => w.endsWith('not found')))
      if (rec.status === 200 && !deletedHere && !reportedNotFound) {
        violation(`${rec.label}: answered 200 without deleting the CR`)
      }
      if (deletedHere && rec.status === 200) bump(`uninstall completed via ${this.via}`)
    }
    toString() {
      return `Uninstall(${label(this.slot)},${this.via}${this.parallel ? ',par' : ''})`
    }
  }

  class Catalog implements Step {
    constructor(readonly parallel: boolean) {}
    async run() {
      const rec = newReq('catalog', this.toString())
      await send(rec, request(H.app).get('/admin/registry/catalog'))
      expectOutcome(rec, [[200, undefined]])
    }
    toString() {
      return `Catalog(${this.parallel ? 'par' : ''})`
    }
  }

  /** A dialog opened on a Context: the snapshot a later stale edit is built from. */
  class OpenDialog implements Step {
    readonly parallel = false
    constructor(readonly ctx: string) {}
    async run() {
      const snap = await readSnapshot('ctxRead', this.ctx)
      if (snap) H.dialogs.set(this.ctx, snap)
      else H.dialogs.delete(this.ctx)
    }
    toString() {
      return `OpenDialog(${this.ctx})`
    }
  }

  type Target = Slot | typeof PLAIN | typeof GHOST
  const targetName = (t: Target) => (typeof t === 'string' ? t : canonical(t))
  const targetLabel = (t: Target) => (typeof t === 'string' ? t : label(t))

  class EditContext implements Step {
    constructor(
      readonly ctx: string,
      readonly target: Target,
      readonly add: boolean,
      readonly stale: boolean,
      readonly parallel: boolean
    ) {}
    async run() {
      const snap =
        this.stale && H.dialogs.has(this.ctx)
          ? H.dialogs.get(this.ctx)
          : await readSnapshot('ctxRead', this.ctx)
      if (!snap) return
      const name = targetName(this.target)
      const servers = [...((snap.spec.mcpServers as string[] | undefined) ?? [])]
      if (servers.includes(name) === this.add) return
      const next = this.add ? [...servers, name] : servers.filter(s => s !== name)
      const rec = newReq('ctxEdit', this.toString())
      await send(
        rec,
        request(H.app)
          .put(`/admin/contexts/${this.ctx}`)
          .send({
            metadata: { resourceVersion: snap.rv },
            spec: { ...snap.spec, mcpServers: next },
          })
      )
      expectOutcome(rec, [
        [200, undefined],
        [409, 'conflict'],
        [404, undefined],
        // A removal resends the rest of the snapshot: a name an uninstall stripped
        // since the read counts as added again, and the ratchet refuses it.
        [422, 'unknown_mcp_server'],
      ])
    }
    toString() {
      return `EditContext(${this.ctx},${this.add ? '+' : '-'}${targetLabel(this.target)},${
        this.stale ? 'stale' : 'fresh'
      }${this.parallel ? ',par' : ''})`
    }
  }

  /** A Context created with a list read earlier, as the Host wizard does. */
  class CreateContext implements Step {
    constructor(
      readonly targets: Target[],
      readonly parallel: boolean
    ) {}
    async run() {
      const rec = newReq('ctxCreate', this.toString())
      await send(
        rec,
        request(H.app)
          .post('/admin/contexts')
          .send({
            metadata: { name: 'c3' },
            spec: { contextId: 'c3', mcpServers: [...new Set(this.targets.map(targetName))] },
          })
      )
      expectOutcome(rec, [
        [201, undefined],
        [409, undefined],
        [422, 'unknown_mcp_server'],
      ])
    }
    toString() {
      return `CreateContext(c3,[${this.targets.map(targetLabel).join(',')}]${this.parallel ? ',par' : ''})`
    }
  }

  type ServerEditKind = 'scopes' | 'baseUrl' | 'annotations'

  /** The edit page: a PUT of the spec read at mount, with no uid nor resourceVersion. */
  class EditServer implements Step {
    constructor(
      readonly slot: Slot,
      readonly kind: ServerEditKind,
      readonly stale: boolean,
      readonly parallel: boolean
    ) {}
    async run() {
      const name = canonical(this.slot)
      let snap = this.stale ? H.serverSnaps.get(name) : undefined
      if (!snap) {
        snap = await readSnapshot('serverRead', name)
        if (!snap) return
        H.serverSnaps.set(name, snap)
      }
      const spec = structuredClone(snap.spec) as StoredObj['spec']
      const metadata: Record<string, unknown> = {}
      if (this.kind === 'scopes') {
        const scopes = spec.oauth?.scopes ?? []
        spec.oauth = {
          ...spec.oauth,
          scopes: scopes.includes('extra.read')
            ? scopes.filter(s => s !== 'extra.read')
            : [...scopes, 'extra.read'],
        }
      } else if (this.kind === 'baseUrl') {
        spec.remote = { ...spec.remote, baseUrl: EVIL_URL }
      } else {
        // Platform annotations survive a replace unless the body sets the key, so a
        // relabel must name it: claim another entry's identity.
        metadata.annotations = {
          ...((snap.metadata.annotations as Record<string, string> | undefined) ?? {}),
          'clerum.io/catalog-id': this.slot.entry === ENTRY.C ? ENTRY.A.name : ENTRY.C.name,
        }
      }
      const rec = newReq('serverEdit', this.toString(), { slot: this.slot })
      await send(rec, request(H.app).put(`/admin/mcp-servers/${name}`).send({ metadata, spec }))
      expectOutcome(rec, [
        [404, undefined],
        [409, 'catalog_instance_immutable'],
        ...(this.kind === 'scopes' ? ([[200, undefined]] as Array<[number, undefined]>) : []),
      ])
    }
    toString() {
      return `EditServer(${label(this.slot)},${this.kind},${this.stale ? 'stale' : 'fresh'}${
        this.parallel ? ',par' : ''
      })`
    }
  }

  /** A generic create that claims a catalog identity, with a URL of its choosing. */
  class Forge implements Step {
    constructor(
      readonly slot: Slot,
      readonly parallel: boolean
    ) {}
    async run() {
      const rec = newReq('forge', this.toString())
      const cr = buildRemoteMcpServerResource({
        serverName: canonical(this.slot),
        namespace: NS,
        baseUrl: EVIL_URL,
        oauth: buildRemoteOAuthSpec(cimdResult, {
          clientMode: 'public',
          grantScope: this.slot.scope,
          cimdClientId: 'https://control.example.com/cimd',
        }),
        annotations: catalogAnnotations(this.slot.entry.name, this.slot.entry.versions[0]),
      })
      await send(rec, request(H.app).post('/admin/mcp-servers').send(cr))
      expectOutcome(rec, [[400, 'catalog_annotations_not_allowed']])
    }
    toString() {
      return `Forge(${label(this.slot)}${this.parallel ? ',par' : ''})`
    }
  }

  function readerKey(cr: StoredObj, name: string, userId: string): OAuthGrantKey | null {
    const resolved = resolveServerOAuth(cr as Parameters<typeof resolveServerOAuth>[0])
    if (!resolved) return null
    return buildMcpServerGrantKey(resolved, {
      mcpServerName: name,
      mcpServersNamespace: NS,
      userId,
      contextId: 'c1',
    })
  }

  /**
   * The consent callback's write: the grant sealed with the uid of the CR it read.
   * The read and the write are apart, as in the callback.
   */
  class Consent implements Step {
    constructor(
      readonly slot: Slot,
      readonly user: string,
      readonly parallel: boolean
    ) {}
    async run() {
      const rec = newReq('consent', this.toString())
      const name = canonical(this.slot)
      await als.run(rec, async () => {
        let cr: StoredObj
        try {
          cr = (await H.api.gateway.getResource('mcpservers', name, NS)) as StoredObj
        } catch {
          return
        }
        const key = readerKey(cr, name, this.user)
        if (!key) {
          violation(`${rec.label}: no grant key for the live CR`)
          return
        }
        await upsertOAuthGrant(gatedDb, KEY, {
          ...key,
          provider: 'remote',
          accessToken: `at-${rec.id}`,
          refreshToken: `rt-${rec.id}`,
          accessTokenExpiresInSec: 3600,
          crUid: cr.metadata.uid,
        } as Parameters<typeof upsertOAuthGrant>[2])
        H.consents.push({ user: this.user, name, uid: cr.metadata.uid, seq: ++H.seq })
      })
    }
    toString() {
      return `Consent(${label(this.slot)},${this.user}${this.parallel ? ',par' : ''})`
    }
  }

  class Release implements Step {
    readonly parallel = false
    async run() {
      const s = H.s
      if (!s) return
      await quiesce()
      if (s.count() > 0) await s.waitOne()
    }
    toString() {
      return 'Release()'
    }
  }

  // ── arbitraries ───────────────────────────────────────────────────────────

  // Mostly concurrent, and mostly on two slots: races need two commands on one slot.
  const par = fc.constantFrom(true, true, true, false)
  // Installs and uninstalls run alone half the time, so later commands find the
  // slot in the state the earlier ones left.
  const installPar = fc.boolean()
  const slotWeight: Record<string, number> = { 'A-u': 6, 'B-u': 4, 'A-c': 1, 'B-c': 1, 'C-u': 1 }
  const slotArb = fc.oneof(
    ...INSTALLABLE.map(s => ({ weight: slotWeight[label(s)], arbitrary: fc.constant(s) }))
  )
  const userSlot = fc.constantFrom(...INSTALLABLE.filter(s => s.scope === 'user'))
  const target: fc.Arbitrary<Target> = fc.oneof(
    { weight: 6, arbitrary: slotArb },
    { weight: 1, arbitrary: fc.constant(PLAIN) },
    { weight: 1, arbitrary: fc.constant(GHOST) }
  )
  const install = fc
    .tuple(
      fc.oneof({ weight: 12, arbitrary: slotArb }, { weight: 1, arbitrary: fc.constant(SLOTS[5]) }),
      fc.nat(1),
      fc.nat(1),
      fc.constantFrom<Tamper>(
        'none',
        'none',
        'none',
        'none',
        'none',
        'none',
        'none',
        'none',
        'none',
        'none',
        'trailingSlash',
        'evilUrl',
        'serverName',
        'alias'
      ),
      fc.constantFrom('client-a', 'client-b'),
      installPar
    )
    .map(([slot, v, m, tamper, clientId, p]) => {
      const modes = slot.entry.modes
      return new Install(
        slot,
        slot.entry.versions[v % slot.entry.versions.length],
        modes[m % modes.length],
        tamper,
        clientId,
        p
      )
    })

  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 8, arbitrary: install },
    {
      weight: 4,
      arbitrary: fc
        .tuple(slotArb, fc.constantFrom<'generic' | 'registry'>('generic', 'registry'), installPar)
        .map(([s, via, p]) => new Uninstall(s, via, p)),
    },
    { weight: 1, arbitrary: par.map(p => new Catalog(p)) },
    { weight: 2, arbitrary: fc.constantFrom('c1', 'c2').map(c => new OpenDialog(c)) },
    {
      weight: 5,
      arbitrary: fc
        .tuple(
          fc.constantFrom(...CONTEXTS),
          target,
          fc.constantFrom(true, true, false),
          fc.boolean(),
          par
        )
        .map(([c, t, add, stale, p]) => new EditContext(c, t, add, stale, p)),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.array(target, { minLength: 1, maxLength: 2 }), par)
        .map(([ts, p]) => new CreateContext(ts, p)),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(
          slotArb,
          fc.constantFrom<ServerEditKind>('scopes', 'scopes', 'baseUrl', 'annotations'),
          fc.boolean(),
          par
        )
        .map(([s, k, stale, p]) => new EditServer(s, k, stale, p)),
    },
    { weight: 1, arbitrary: fc.tuple(slotArb, par).map(([s, p]) => new Forge(s, p)) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(userSlot, fc.constantFrom('user-1', 'user-2'), par)
        .map(([s, u, p]) => new Consent(s, u, p)),
    },
    { weight: 6, arbitrary: fc.constant(new Release()) }
  )

  // ── run lifecycle ─────────────────────────────────────────────────────────

  const originalContextsNamespace = config.contextsNamespace
  const originalCallbackBaseUrl = config.oauthCallbackBaseUrl

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    rawDb = { query: (text, values) => dbPool.query(text, values) }
    testDb.query = gatedQuery as never
    testDb.txPool = txPool
    asDouble.transport = asTransport as never
    config.contextsNamespace = CTX_NS
    // DCR registers a redirect URI on the public callback origin.
    config.oauthCallbackBaseUrl = 'https://control.example.com'

    cimdResult = await discoverPilot(withRfc9207(PILOTS.notion))
    expect(cimdResult.registrationMode).toBe('cimd')
    discovery.set('A', cimdResult)
    const dcrResult = await discoverPilot(withRfc9207(dcrPilot('confidential')))
    expect(dcrResult.registrationMode).toBe('dcr')
    discovery.set('B', dcrResult)
    const linearResult = await discoverPilot(withRfc9207(PILOTS.linear))
    discovery.set('C', linearResult)
    ENTRY.C.modes = [linearResult.registrationMode as Mode]

    registryDouble.rows.clear()
    registryDouble.latest = []
    for (const entry of ENTRIES) {
      for (const version of entry.versions) {
        const row = registryEntryRow(
          {
            name: entry.name,
            version,
            mcpServer: {
              serverMode: 'remote',
              transport: 'streamableHttp',
              remoteEndpoints: [{ url: entry.url }],
              oauth: {
                source: 'remote',
                allowedGrantScopes: entry.scopes,
                expectedRegistration: entry.expectedRegistration,
              },
            },
          },
          { kind: 'curator-machine' }
        ) as unknown as Record<string, unknown>
        registryDouble.rows.set(`${entry.name}@${version}`, row)
      }
      registryDouble.latest.push(
        registryDouble.rows.get(`${entry.name}@${entry.versions[entry.versions.length - 1]}`)!
      )
    }
  })

  afterAll(async () => {
    try {
      config.contextsNamespace = originalContextsNamespace
      config.oauthCallbackBaseUrl = originalCallbackBaseUrl
      testDb.query = undefined
      testDb.txPool = undefined
      asDouble.transport = undefined
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

  /** Initial world through production writers: one manual server, two Contexts. */
  /** Slots installed (and possibly enabled in c2) before the commands start. */
  type Initial = Array<{ slot: Slot; mode: number; enable: boolean }>
  const initialArb: fc.Arbitrary<Initial> = fc.uniqueArray(
    fc.record({ slot: slotArb, mode: fc.nat(1), enable: fc.boolean() }),
    { maxLength: 3, selector: i => label(i.slot) }
  )

  async function startRun(initial: Initial): Promise<void> {
    H.s = null
    H.seq = 0
    H.reqCounter = 0
    H.reqs = []
    H.violations = []
    H.dbTail = Promise.resolve()
    H.consents = []
    H.dialogs = new Map()
    H.serverSnaps = new Map()
    H.active = 0
    H.parked = 0
    await dbPool.query('TRUNCATE oauth_grants, dynamic_clients')
    H.api = fakeCustomObjectsApiserver({
      namespaces: { contexts: CTX_NS, mcpservers: NS },
      defaultNamespace: NS,
    })
    instrumentApiserver(H.api)
    H.secrets = new MockGateway(NS)
    H.app = buildApp(compositeGateway())

    const plain = buildRemoteMcpServerResource({
      serverName: PLAIN,
      namespace: NS,
      baseUrl: NOTION_URL,
      oauth: buildRemoteOAuthSpec(cimdResult, {
        clientMode: 'public',
        grantScope: 'user',
        cimdClientId: 'https://control.example.com/cimd',
      }),
    })
    const created = await request(H.app).post('/admin/mcp-servers').send(plain)
    if (created.status !== 201) throw new Error(`setup: plain server ${created.status}`)
    for (const [name, servers] of [
      ['c1', [PLAIN]],
      ['c2', []],
    ] as const) {
      const res = await request(H.app)
        .post('/admin/contexts')
        .send({ metadata: { name }, spec: { contextId: name, mcpServers: [...servers] } })
      if (res.status !== 201) throw new Error(`setup: context ${name} ${res.status}`)
    }
    // Through the same commands, unscheduled: their requests join the model as any other.
    for (const { slot, mode, enable } of initial) {
      const modes = slot.entry.modes
      await new Install(
        slot,
        slot.entry.versions[0],
        modes[mode % modes.length],
        'none',
        'client-a',
        false
      ).run()
      if (enable) await new EditContext('c2', slot, true, false, false).run()
    }
    if (H.violations.length > 0) throw new Error(`setup: ${H.violations.join('; ')}`)
  }

  // ── at rest ───────────────────────────────────────────────────────────────

  function storedServers(): StoredObj[] {
    return [...H.api.store.entries()]
      .filter(([k]) => k.startsWith(`mcpservers/${NS}/`))
      .map(([, v]) => structuredClone(v) as StoredObj)
  }

  function storedContexts(): StoredObj[] {
    return [...H.api.store.entries()]
      .filter(([k]) => k.startsWith(`contexts/${CTX_NS}/`))
      .map(([, v]) => structuredClone(v) as StoredObj)
  }

  /**
   * An add of `name` that an uninstall of `name` could not see: the uninstall listed
   * the Contexts before the write, and the edit found the CR alive (the same uid the
   * uninstall deleted) before the uninstall deleted it.
   */
  function addedInsideStripWindow(adder: Req, write: CtxWrite, name: string): boolean {
    return H.reqs.some(
      u =>
        u.kind === 'uninstall' &&
        u.ctxLists.length > 0 &&
        u.ctxLists[0] < write.seq &&
        u.crDeletes.some(
          d =>
            d.name === name &&
            adder.mcpReads.some(r => r.name === name && r.uid === d.uid && r.seq < d.seq)
        )
    )
  }

  /**
   * A dynamic client an uninstall could not see: the install bound its pending row
   * to the CR after the uninstall's teardown claimed rows by that uid (a pending row
   * has no uid yet, so the claim misses it), and that uninstall then deleted the CR.
   * The row stays bound to a dead uid until the next install of the name reclaims it.
   */
  function boundAfterTeardownClaim(name: string, uid: string): boolean {
    return H.reqs.some(
      i =>
        i.kind === 'install' &&
        i.dcrBinds.some(
          b =>
            b.name === name &&
            b.uid === uid &&
            H.reqs.some(
              u =>
                u.kind === 'uninstall' &&
                u.crDeletes.some(d => d.uid === uid) &&
                u.mcpReads.some(r => r.uid === uid && r.seq < b.seq) &&
                u.dcrClaims.some(c => c.uid === uid && c.seq < b.seq)
            )
        )
    )
  }

  async function checkAtRest(): Promise<void> {
    const servers = storedServers()
    const byName = new Map(servers.map(s => [s.metadata.name, s]))

    // Live CRs: what the 201 installs created, minus what an uninstall deleted.
    const deletedUids = new Set(
      H.reqs.filter(r => r.kind === 'uninstall').flatMap(r => r.crDeletes.map(d => d.uid))
    )
    const modelLive = new Map<string, string>()
    for (const rec of H.reqs) {
      if (rec.kind !== 'install' || rec.status !== 201) continue
      const name = String(rec.body?.serverName)
      const create = rec.crCreates.find(c => c.name === name)
      if (!create) {
        violation(`${rec.label}: 201 without creating ${name}`)
        continue
      }
      if (!deletedUids.has(create.uid)) modelLive.set(name, create.uid)
    }
    for (const s of servers) {
      if (s.metadata.name === PLAIN) continue
      if (modelLive.get(s.metadata.name) !== s.metadata.uid) {
        violation(
          `I6: CR ${s.metadata.name} (${s.metadata.uid}) is live but no 201 install explains it`
        )
      }
    }
    for (const [name, uid] of modelLive) {
      if (byName.get(name)?.metadata.uid !== uid) {
        violation(`I6: ${name} (${uid}) was installed and never uninstalled, but is gone`)
      }
    }
    if (!byName.has(PLAIN)) violation('the manual server disappeared')

    // A losing install never deletes what it did not create.
    for (const rec of H.reqs.filter(r => r.kind === 'install')) {
      const own = new Set(rec.crCreates.map(c => c.uid))
      for (const d of rec.crDeletes) {
        if (!own.has(d.uid)) violation(`${rec.label}: deleted CR ${d.name} it did not create`)
      }
      const ownSecrets = new Set(rec.secretCreates.map(c => c.uid))
      for (const d of rec.secretDeletes) {
        if (!d.uid || !ownSecrets.has(d.uid)) {
          violation(`${rec.label}: deleted Secret ${d.name} it did not create`)
        }
      }
    }

    // I1: at most one catalog instance per slot.
    const instances = servers.filter(
      s => s.metadata.annotations?.['clerum.io/catalog-id'] && s.spec.oauth?.source === 'remote'
    )
    const perSlot = new Map<string, string[]>()
    for (const s of instances) {
      const k = `${s.metadata.annotations!['clerum.io/catalog-id']}|${s.spec.oauth?.grantScope}`
      perSlot.set(k, [...(perSlot.get(k) ?? []), s.metadata.name])
    }
    for (const [k, names] of perSlot) {
      if (names.length > 1) violation(`I1: slot ${k} has ${names.length} instances: ${names}`)
    }

    // I3: name, URL and scope of every catalog instance come from its entry.
    for (const s of instances) {
      const id = s.metadata.annotations!['clerum.io/catalog-id']
      const version = s.metadata.annotations!['clerum.io/catalog-version']
      const entry = ENTRIES.find(e => e.name === id)
      const scope = s.spec.oauth?.grantScope as Scope
      const where = `I3: ${s.metadata.name}`
      if (!entry) {
        violation(`${where}: catalog-id ${id} is no entry`)
        continue
      }
      if (!entry.versions.includes(version)) violation(`${where}: version ${version}`)
      if (!entry.scopes.includes(scope)) violation(`${where}: scope ${scope} not allowed`)
      if (s.metadata.name !== deriveCatalogRemoteServerName(id, scope)) {
        violation(`${where}: not the canonical name of ${id}/${scope}`)
      }
      if (s.spec.remote?.baseUrl !== entry.url) {
        violation(`${where}: baseUrl ${s.spec.remote?.baseUrl} ≠ ${entry.url}`)
      }
      const path = new URL(entry.url).pathname
      const transportUrl = s.spec.transport?.url ?? ''
      if (
        !transportUrl.startsWith(`http://${s.metadata.name}.${NS}.svc.cluster.local:`) ||
        !transportUrl.endsWith(path)
      ) {
        violation(`${where}: transport.url ${transportUrl}`)
      }
      if (s.spec.egressBindings?.[0]?.dns !== new URL(entry.url).hostname) {
        violation(`${where}: egress ${s.spec.egressBindings?.[0]?.dns}`)
      }
    }

    // I6: the catalog shows exactly the live slots; a free slot keeps no residue.
    const res = await request(H.app).get('/admin/registry/catalog')
    if (res.status !== 200)
      violation(`catalog at rest answered ${res.status} ${res.text.slice(0, 300)}`)
    const slots = (res.body?.installed?.remoteOAuthSlots ?? {}) as Record<
      string,
      Record<string, Record<string, unknown> | undefined>
    >
    for (const slot of SLOTS) {
      const name = canonical(slot)
      const shown = slots[slot.entry.name]?.[slot.scope]
      const live = byName.get(name)
      if (live && modelLive.has(name)) {
        const want = {
          kind: 'instance',
          serverName: name,
          version: live.metadata.annotations?.['clerum.io/catalog-version'],
          canonical: true,
          terminating: false,
        }
        if (JSON.stringify(shown) !== JSON.stringify(want)) {
          violation(`I6: catalog shows ${label(slot)} as ${JSON.stringify(shown)}`)
        }
      } else if (!live && shown !== undefined) {
        violation(`I6: free slot ${label(slot)} shown as ${JSON.stringify(shown)}`)
      }
      const secretName = `${name}-oauth-client`
      const secret = await H.secrets.getSecret(secretName, NS).then(
        s => s,
        () => undefined
      )
      const wantsSecret = Boolean(
        (live?.spec.oauth?.clientSecretRef as { name?: string } | undefined)?.name === secretName
      )
      if (Boolean(secret) !== wantsSecret) {
        violation(
          `I6: ${secretName} ${secret ? 'left behind' : 'missing'} (CR ${live ? 'live' : 'gone'})`
        )
      }
      const rows = await rawDb.query(
        `SELECT cr_uid, install_id FROM dynamic_clients WHERE server_namespace = $1 AND server_name = $2`,
        [NS, name]
      )
      for (const row of rows.rows as Array<{ cr_uid: string | null }>) {
        if (!live || row.cr_uid !== live.metadata.uid) {
          if (row.cr_uid && boundAfterTeardownClaim(name, row.cr_uid)) {
            bump('dynamic client bound after the uninstall teardown')
            continue
          }
          violation(
            `I6: dynamic client of ${name} bound to ${row.cr_uid} (CR ${live?.metadata.uid ?? 'gone'})`
          )
        }
      }
      if (live && slot.scope === 'user') {
        for (const user of ['user-1', 'user-2']) {
          const key = readerKey(live, name, user)
          if (!key) continue
          const served = (await getOAuthGrant(rawDb, KEY, key)) !== null
          const last = H.consents
            .filter(c => c.user === user && c.name === name)
            .sort((a, b) => b.seq - a.seq)[0]
          const expected = last?.uid === live.metadata.uid
          if (served !== expected) {
            violation(`I6: ${user} on ${name} served=${served}, model=${expected}`)
          }
          if (served) bump('grant served by the live install')
          if (!served && H.consents.some(c => c.user === user && c.name === name)) {
            bump('grant of an earlier install inert')
          }
        }
      }
    }

    // I8: no Context write through control-api adds a name without a live McpServer,
    // except inside an uninstall's strip window.
    const live = new Set(servers.map(s => s.metadata.name))
    for (const rec of H.reqs) {
      for (const w of rec.ctxWrites) {
        if (rec.kind !== 'ctxEdit' && rec.kind !== 'ctxCreate') continue
        for (const name of w.after.filter(n => !w.before.includes(n))) {
          if (w.liveAtWrite.has(name)) continue
          if (addedInsideStripWindow(rec, w, name)) {
            bump('add landed after the CR delete, inside the strip window')
            continue
          }
          violation(`I8: ${rec.label} added ${name} to ${w.ctx} with no live McpServer`)
        }
      }
      if (
        rec.kind === 'uninstall' &&
        rec.ctxWrites.some(w => !w.before.includes(String(canonical(rec.slot!))))
      ) {
        violation(`${rec.label}: rewrote a Context that did not list the server`)
      }
    }
    for (const ctx of storedContexts()) {
      for (const name of ctx.spec.mcpServers ?? []) {
        if (live.has(name)) continue
        const adds = H.reqs.flatMap(rec =>
          rec.ctxWrites
            .filter(
              w => w.ctx === ctx.metadata.name && w.after.includes(name) && !w.before.includes(name)
            )
            .map(w => ({ rec, w }))
        )
        const lastAdd = adds.sort((a, b) => b.w.seq - a.w.seq)[0]
        if (lastAdd && addedInsideStripWindow(lastAdd.rec, lastAdd.w, name)) {
          bump('dangling name left by the strip window')
          continue
        }
        violation(
          `I8: ${ctx.metadata.name} lists ${name} with no live McpServer` +
            (lastAdd ? ` (added by ${lastAdd.rec.label})` : '')
        )
      }
    }

    bump('install 201 on a slot uninstalled earlier', countReinstalls())
  }

  function countReinstalls(): number {
    const freed = new Set(
      H.reqs.filter(r => r.kind === 'uninstall').flatMap(r => r.crDeletes.map(d => d.name))
    )
    return H.reqs.filter(
      r =>
        r.kind === 'install' &&
        r.status === 201 &&
        freed.has(String(r.body?.serverName)) &&
        r.crCreates.some(c =>
          H.reqs.some(u => u.crDeletes.some(d => d.name === c.name && d.seq < c.seq))
        )
    ).length
  }

  it('every interleaving keeps one instance per slot, curated identity, an honest catalog and clean allowlists', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        initialArb,
        fc.commands([step as unknown as fc.Arbitrary<fc.AsyncCommand<object, object>>], {
          maxCommands: MAX_COMMANDS,
          size: '+1',
        }),
        async (s, initial, cmds) => {
          await startRun(initial)
          H.s = s
          const pending: Promise<void>[] = []
          const launch = (st: Step) => {
            H.active += 1
            return st
              .run()
              .catch(err => {
                violation(`${st.toString()} threw: ${(err as Error).stack ?? String(err)}`)
              })
              .finally(() => {
                H.active -= 1
              })
          }
          try {
            await fc.asyncModelRun(
              () => ({ model: {}, real: {} }),
              [...cmds].map(cmd => {
                // `fc.commands` iterates wrappers that keep the generated command in `cmd`;
                // reading `parallel` off the wrapper would run every step in sequence. The
                // wrapper's `hasRan` is what shrinking and the printed counterexample keep.
                const wrapper = cmd as unknown as { cmd?: Step; hasRan?: boolean }
                const st = (wrapper.cmd ?? cmd) as unknown as Step
                return {
                  check: () => true,
                  run: async () => {
                    wrapper.hasRan = true
                    if (st instanceof Release) await st.run()
                    else if (st.parallel) pending.push(launch(st))
                    else await drain(s, launch(st))
                  },
                  toString: () => st.toString(),
                }
              })
            )
            await drain(s, Promise.allSettled(pending))
            await s.waitIdle()
            if (s.count() > 0) violation(`${s.count()} scheduled tasks never settled`)
          } finally {
            H.s = null
          }
          await H.dbTail
          await checkAtRest()
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
                `requests: ${H.reqs.map(r => `${r.label}→${r.status ?? '-'}`).join(' ; ')}`,
                `scheduler order (${order.length}):`,
                ...order.map((what, i) => `  ${i + 1}. ${what}`),
              ].join('\n')
            )
          }
        }
      ),
      { numRuns: NUM_RUNS, seed: SEED, endOnFailure: !process.env.FC_SHRINK }
    )
    if (process.env.FC_COVERAGE) process.stderr.write(`${JSON.stringify(coverage, null, 2)}\n`)
    for (const reached of [
      'install 201',
      'install 409 server_name_in_use',
      'install 409 install_in_progress',
      'uninstall completed via generic',
      'uninstall completed via registry',
      'install 201 on a slot uninstalled earlier',
      'ctxEdit 422 unknown_mcp_server',
      'ctxEdit 409 conflict',
      'serverEdit 409 catalog_instance_immutable',
      'serverEdit 200',
      'forge 400 catalog_annotations_not_allowed',
      'grant served by the live install',
      'dangling name left by the strip window',
    ]) {
      expect(
        coverage[reached] ?? 0,
        `runs never reached: ${reached} (reached: ${JSON.stringify(coverage)})`
      ).toBeGreaterThan(0)
    }
  }, 600_000)
})
