import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'

// Concurrent users at the external GFS rate limits, through the production
// Express app against real PostgreSQL. Config, the core and limiter pools, both limiters,
// the session lifecycle query, authority resolution, the prom registry and the
// logger are real; the ONLY mocks are the session-token verifier (identity),
// which decodes a JSON test token so each scenario controls users and sessions,
// and, in E3 only, the fetch to gfsc (the service boundary).
//
// The pools run at their production bounds: every CORE_POOL_* and
// RATE_LIMIT_POOL_* variable is deleted before db.js is imported, so a 503
// from either pool fails the exact tallies below. Each scenario serves its app
// from one listening server and sends through one keep-alive agent.
//
// Denial source, for status 429 only, and only on the
// resource read and resource mutation routes. Those routes have no
// rateLimitMiddleware, so their headers identify the limiter:
// - route backstop: RateLimit-Policy === "<route L>;w=60";
// - Postgres bucket: RateLimit-Policy === "<ingress L>;w=60" AND
//   X-RateLimit-Remaining === "0" AND X-RateLimit-Limit === "<bucket L>";
// - anything else fails the test.
// GET /grants and GET /shares also run rateLimitMiddleware, whose 429 carries
// the same headers as a Postgres bucket's, so the classifier refuses those
// routes and S2b attributes their denials through the ledger and the metric.
// Headers cannot say WHICH Postgres bucket denied, so every scenario also reads
// the rate_limit_buckets ledger: each hit increments its row once and a bucket
// only sees requests that passed the buckets before it, so per (key, window)
// denials = max(0, count - limit). The key prefix names the phase. Nothing
// prunes the ledger here: cleanupExpiredBuckets runs only from main.ts.
//
// Both limiters read Date.now(), so faking only Date pins their windows. Time
// only moves forward, each scenario deletes the ledger, uses fresh identities,
// and builds a new app after setting the budgets (the express backstops and
// the grants read limiter capture their limit when the router is created).
// Skipped without CONTROL_API_REAL_PG_ADMIN_URL.

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (token: string) => {
    const parsed = JSON.parse(token) as { userId: string }
    return {
      userId: parsed.userId,
      email: `${parsed.userId}@example.test`,
      teamId: null,
      role: 'member',
      authGeneration: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
  },
}))

const INGRESS_L = 1_800
const IP_L_DEFAULT = 1_200
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** The shipped defaults (config.ts); beforeAll asserts config still has them. */
const PRODUCTION_BUDGETS: Budgets = {
  resource: 480,
  proxy: 480,
  grants: 120,
  shares: 120,
  operation: 90,
  ip: IP_L_DEFAULT,
}

const RESOURCE_READ_ROUTE = /^\/api\/v1\/external\/gfs\/resources\/[0-9a-f-]{36}\/affordances\?/
const RESOURCE_MUTATION_ROUTE = /^\/api\/v1\/external\/gfs\/resources\/[0-9a-f-]{36}\/children\?/

/**
 * E4 fixture: every Desktop resource-class read on cluster clerum on
 * 2026-09-18 (UTC), the day of the Desktop 429 incident, as ms since 00:00 UTC.
 */
const DESKTOP_READS_2026_09_18 = (
  JSON.parse(
    readFileSync(
      new URL('./fixtures/external-gfs-desktop-reads-2026-09-18.json', import.meta.url),
      'utf-8'
    )
  ) as { offsetsMs: number[] }
).offsetsMs

/** Every read class at `read`: for scenarios that exercise one read class. */
function uniformBudgets(read: number, operation: number, ip: number): Budgets {
  return { resource: read, proxy: read, grants: read, shares: read, operation, ip }
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type Budgets = {
  resource: number
  proxy: number
  grants: number
  shares: number
  operation: number
  ip: number
}
type Sent = {
  path: string
  status: number
  body: { error?: unknown }
  policy?: string
  xLimit?: string
  xRemaining?: string
}
type LedgerRow = { key: string; windowStartMs: number; count: number }
type Phase = 'pre-resolution' | 'resolved-operation' | 'edge-backstop'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('external GFS rate limits under concurrent load (real PostgreSQL)', () => {
  const database = `control_api_gfs_rl_stress_${randomBytes(6).toString('hex')}`
  const envKeys = [
    'CONTROL_API_PG_CONNECTION_STRING',
    'CORE_POOL_MAX',
    'CORE_POOL_CONNECTION_TIMEOUT_MS',
    'CORE_POOL_STATEMENT_TIMEOUT_MS',
    'RATE_LIMIT_POOL_MAX',
    'RATE_LIMIT_POOL_CONNECTION_TIMEOUT_MS',
    'RATE_LIMIT_POOL_STATEMENT_TIMEOUT_MS',
  ] as const
  const previousEnv = new Map<string, string | undefined>()

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    assertExternalGfsBudgetInvariants: typeof import('../src/config.js').assertExternalGfsBudgetInvariants
    pool: import('../src/db.js').DbClient
    rootLogger: typeof import('../src/observability/logger.js').rootLogger
    requestsTotal: typeof import('../src/observability/metrics.js').externalGfsRateLimitRequestsTotal
    backendErrorsTotal: typeof import('../src/observability/metrics.js').rateLimitBackendErrorsTotal
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }
  // Forward-only fake clock: every scenario starts on a later minute.
  let nextScenarioMinuteMs = 0

  beforeAll(async () => {
    if (adminUrl === undefined) {
      throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required by this suite')
    }
    const connectionString = databaseUrl(adminUrl, database)
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key])
      delete process.env[key]
    }
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    // Witness that nothing raised the bounds: core 10 / 2000 ms, limiter 6 / 5000 ms.
    type PoolOptions = { options: { max: number; connectionTimeoutMillis: number } }
    expect((corePool as unknown as PoolOptions).options).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 2_000,
    })
    expect((dbMod.rateLimitPool as unknown as PoolOptions).options).toMatchObject({
      max: 6,
      connectionTimeoutMillis: 5_000,
    })
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await migratePool.end()

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const loggerMod = await import('../src/observability/logger.js')
    const metricsMod = await import('../src/observability/metrics.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      config: configMod.config,
      assertExternalGfsBudgetInvariants: configMod.assertExternalGfsBudgetInvariants,
      pool: dbMod.pool,
      rootLogger: loggerMod.rootLogger,
      requestsTotal: metricsMod.externalGfsRateLimitRequestsTotal,
      backendErrorsTotal: metricsMod.rateLimitBackendErrorsTotal,
      MockGateway,
    }
    expect(mod.config.externalGfsIngressRlPerMin).toBe(INGRESS_L)
    // E1-E4 run at PRODUCTION_BUDGETS; they must be the shipped defaults.
    expect({
      resource: mod.config.externalGfsResourceReadRlPerMin,
      proxy: mod.config.externalGfsProxyReadRlPerMin,
      grants: mod.config.externalGfsGrantsReadRlPerMin,
      shares: mod.config.externalGfsSharesReadRlPerMin,
      operation: mod.config.externalGfsOperationRlPerMin,
      ip: mod.config.externalGfsIpRlPerMin,
    }).toEqual(PRODUCTION_BUDGETS)
    vi.useFakeTimers({ toFake: ['Date'] })
    nextScenarioMinuteMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + 10 * MINUTE_MS
  }, 60_000)

  // The server of the running scenario; closed after every test.
  let openServer: { close: () => Promise<void> } | null = null
  afterEach(async () => {
    const server = openServer
    openServer = null
    await server?.close()
  })

  afterAll(async () => {
    vi.useRealTimers()
    for (const key of envKeys) {
      const value = previousEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await corePool?.end().catch(() => {})
    await limiterPool?.end().catch(() => {})
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  /**
   * Sets a boot-valid budget, clears the ledger, serves a fresh app and
   * returns its `send` and the scenario start. The start is a multiple of
   * `alignMs` (a minute, or a UTC day for the E4 replay), and the next
   * scenario starts at least `spanMs` later.
   */
  async function startScenario(budgets: Budgets, spanMs = 5 * MINUTE_MS, alignMs = MINUTE_MS) {
    mod.assertExternalGfsBudgetInvariants({
      resourceReadPerMin: budgets.resource,
      proxyReadPerMin: budgets.proxy,
      grantsReadPerMin: budgets.grants,
      sharesReadPerMin: budgets.shares,
      operationPerMin: budgets.operation,
      ipPerMin: budgets.ip,
    })
    mod.config.externalGfsResourceReadRlPerMin = budgets.resource
    mod.config.externalGfsProxyReadRlPerMin = budgets.proxy
    mod.config.externalGfsGrantsReadRlPerMin = budgets.grants
    mod.config.externalGfsSharesReadRlPerMin = budgets.shares
    mod.config.externalGfsOperationRlPerMin = budgets.operation
    mod.config.externalGfsIpRlPerMin = budgets.ip
    await mod.pool.query('DELETE FROM rate_limit_buckets')
    const minuteMs = Math.ceil(nextScenarioMinuteMs / alignMs) * alignMs
    nextScenarioMinuteMs = minuteMs + spanMs
    vi.setSystemTime(minuteMs + 10_000)
    const send = await serve(mod.createApp(new mod.MockGateway()))
    return { send, minuteMs }
  }

  /** Serves `app` on one listening server; `send` reuses one keep-alive agent. */
  async function serve(app: import('express').Express) {
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const agent = new http.Agent({ keepAlive: true })
    if (openServer) throw new Error('a scenario server is already open')
    openServer = {
      close: () => {
        agent.destroy()
        server.closeAllConnections()
        return new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      },
    }

    /** GET, or POST with `post.body` as JSON. */
    return function send(
      path: string,
      token: string,
      ip: string,
      post?: { body: unknown }
    ): Promise<Sent> {
      const method = post === undefined ? 'GET' : 'POST'
      const payload = post === undefined ? undefined : JSON.stringify(post.body)
      const headers: Record<string, string> = {
        authorization: `Bearer ${internalToken}`,
        'x-service-token': 'external-rest-api',
        'x-user-session-token': token,
        'x-forwarded-for': ip,
      }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(Buffer.byteLength(payload))
      }
      return new Promise<Sent>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, agent, headers }, res => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8')
            try {
              resolve({
                path,
                status: res.statusCode ?? 0,
                body: (text === '' ? {} : JSON.parse(text)) as { error?: unknown },
                policy: singleHeader(res, 'ratelimit-policy'),
                xLimit: singleHeader(res, 'x-ratelimit-limit'),
                xRemaining: singleHeader(res, 'x-ratelimit-remaining'),
              })
            } catch (error) {
              reject(
                new Error(
                  `${method} ${path} answered ${res.statusCode} with a non-JSON body ` +
                    `(${String(error)}): ${text}`
                )
              )
            }
          })
        })
        req.on('error', reject)
        req.end(payload)
      })
    }
  }

  function singleHeader(res: http.IncomingMessage, name: string): string | undefined {
    const value = res.headers[name]
    if (Array.isArray(value)) throw new Error(`header ${name} repeated: ${value.join(', ')}`)
    return value
  }

  async function seedUser(): Promise<string> {
    const id = randomUUID()
    await mod.pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `${id}@example.test`,
      'stress',
    ])
    return id
  }

  const sessionToken = (userId: string, session = 0) => JSON.stringify({ userId, session })
  const affordancesPath = (resourceId: string) =>
    `/api/v1/external/gfs/resources/${resourceId}/affordances?drive=main`
  const grantsPath = (resourceId: string) =>
    `/api/v1/external/gfs/grants?drive=main&resourceId=${resourceId}`

  const childrenPath = (resourceId: string) =>
    `/api/v1/external/gfs/resources/${resourceId}/children?drive=main`

  /**
   * Denial-source classifier, for the two routes whose 429 headers identify the
   * limiter (see the header comment). Any other route throws. Allowed
   * responses keep their status.
   */
  function classify(
    response: Sent,
    route: 'resource-read' | 'resource-mutation',
    budgets: Budgets
  ): string {
    const [pattern, routeL] =
      route === 'resource-read'
        ? [RESOURCE_READ_ROUTE, budgets.resource]
        : [RESOURCE_MUTATION_ROUTE, budgets.operation]
    if (!pattern.test(response.path)) {
      throw new Error(`classify(${route}) received ${response.path}`)
    }
    if (response.status !== 429) return `allowed:${response.status}`
    if (response.policy === `${routeL};w=60`) return 'route-backstop'
    if (response.policy === `${INGRESS_L};w=60` && response.xRemaining === '0')
      return `postgres:${response.xLimit}`
    return `unclassified:${JSON.stringify(response)}`
  }

  function tally(labels: string[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const label of labels) counts[label] = (counts[label] ?? 0) + 1
    return counts
  }

  async function readLedger(): Promise<LedgerRow[]> {
    const result = await mod.pool.query(
      `SELECT bucket_key, window_start_ms::text AS window_start_ms, count
         FROM rate_limit_buckets ORDER BY bucket_key, window_start_ms`
    )
    return (
      result.rows as Array<{ bucket_key: string; window_start_ms: string; count: number }>
    ).map(row => ({
      key: row.bucket_key,
      windowStartMs: Number(row.window_start_ms),
      count: Number(row.count),
    }))
  }

  /** Sorted counts of the rows whose key starts with `prefix`, optionally in one window. */
  function counts(ledger: LedgerRow[], prefix: string, windowStartMs?: number): number[] {
    return ledger
      .filter(
        row =>
          row.key.startsWith(prefix) &&
          (windowStartMs === undefined || row.windowStartMs === windowStartMs)
      )
      .map(row => row.count)
      .sort((a, b) => a - b)
  }

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

  /** Limit of every bucket key these scenarios can create; an unknown key fails loudly. */
  function limitOf(key: string, budgets: Budgets): number {
    if (key.startsWith('gfs-ext:pre:ip:')) return budgets.ip
    if (/^gfs-ext:(pre|resolved):resource:/.test(key)) return budgets.resource
    if (/^gfs-ext:(pre|resolved):resource-mutation:/.test(key)) return budgets.operation
    if (/^gfs-ext:(pre|resolved):grants-read:/.test(key)) return budgets.grants
    // GET /grants and GET /shares share this bucket; its limit is the sum.
    if (key.startsWith('gfsgrants-ext-read:user:')) return budgets.grants + budgets.shares
    throw new Error(`unexpected rate limit bucket in the ledger: ${key}`)
  }

  /** Ledger identity: Postgres denials = sum over (key, window) of max(0, count - limit). */
  function ledgerDenials(ledger: LedgerRow[], budgets: Budgets): number {
    return sum(ledger.map(row => Math.max(0, row.count - limitOf(row.key, budgets))))
  }

  async function deniedByPhase(): Promise<Record<Phase, number>> {
    const { values } = await mod.requestsTotal.get()
    const totals: Record<Phase, number> = {
      'pre-resolution': 0,
      'resolved-operation': 0,
      'edge-backstop': 0,
    }
    for (const sample of values) {
      if (sample.labels.outcome !== 'denied') continue
      const phase = sample.labels.phase as Phase
      if (!(phase in totals)) throw new Error(`unexpected rate limit phase label: ${phase}`)
      totals[phase] += sample.value
    }
    return totals
  }

  async function backendErrors(): Promise<number> {
    return (await mod.backendErrorsTotal.get()).values[0]?.value ?? 0
  }

  /**
   * Captures denial log lines by phase and every limiter DB error during `run`.
   * DB errors are read from the counter: the rate_limit_db_error line is
   * throttled, so counting lines would undercount.
   */
  async function observed<T>(run: () => Promise<T>) {
    const warn = vi.spyOn(mod.rootLogger, 'warn').mockImplementation(() => {})
    const before = await deniedByPhase()
    const errorsBefore = await backendErrors()
    try {
      const result = await run()
      const after = await deniedByPhase()
      const errorsAfter = await backendErrors()
      const payloads = warn.mock.calls.map(call => call[0] as { event?: string; phase?: string })
      const logged = (phase: Phase) =>
        payloads.filter(p => p.event === 'external_gfs_rate_limit' && p.phase === phase).length
      return {
        result,
        metricDelta: {
          'pre-resolution': after['pre-resolution'] - before['pre-resolution'],
          'resolved-operation': after['resolved-operation'] - before['resolved-operation'],
          'edge-backstop': after['edge-backstop'] - before['edge-backstop'],
        },
        logged: {
          'pre-resolution': logged('pre-resolution'),
          'resolved-operation': logged('resolved-operation'),
          'edge-backstop': logged('edge-backstop'),
        },
        dbErrors: errorsAfter - errorsBefore,
      }
    } finally {
      warn.mockRestore()
    }
  }

  it('S1: 20 users with distinct sessions and IPs each get exactly the read budget', async () => {
    const budgets = uniformBudgets(6, 6, IP_L_DEFAULT)
    const { send } = await startScenario(budgets)
    const users = await Promise.all(Array.from({ length: 20 }, () => seedUser()))
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        users.flatMap((userId, index) =>
          Array.from({ length: 10 }, () =>
            send(affordancesPath(resourceId), sessionToken(userId), `198.51.100.${index + 1}`)
          )
        )
      )
    )
    const labels = run.result.map(response => classify(response, 'resource-read', budgets))

    expect(run.result).toHaveLength(200)
    for (let user = 0; user < 20; user += 1) {
      expect(tally(labels.slice(user * 10, user * 10 + 10))).toEqual({
        'allowed:200': 6,
        'postgres:6': 4,
      })
    }
    const ledger = await readLedger()
    expect(counts(ledger, 'gfs-ext:pre:resource:session:')).toEqual(Array(20).fill(10))
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:')).toEqual(Array(20).fill(6))
    expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual(Array(20).fill(6))
    expect(counts(ledger, 'gfs-ext:resolved:resource:actor:user-session:')).toEqual(
      Array(20).fill(6)
    )
    expect(ledgerDenials(ledger, budgets)).toBe(80)
    // S6: the Postgres denials are logged and counted exactly once each; the
    // 120 allowed requests passed the backstop, which denied none of them.
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 80,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 120_000)

  it('S2a: 20 users behind one IP share the (class, IP) read bucket', async () => {
    const budgets = uniformBudgets(30, 30, IP_L_DEFAULT)
    const { send } = await startScenario(budgets)
    const users = await Promise.all(Array.from({ length: 20 }, () => seedUser()))
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        users.flatMap(userId =>
          Array.from({ length: 5 }, () =>
            send(affordancesPath(resourceId), sessionToken(userId), '198.51.100.30')
          )
        )
      )
    )

    expect(tally(run.result.map(response => classify(response, 'resource-read', budgets)))).toEqual(
      {
        'allowed:200': 30,
        'postgres:30': 70,
      }
    )
    const ledger = await readLedger()
    expect(counts(ledger, 'gfs-ext:pre:resource:session:')).toEqual(Array(20).fill(5))
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:')).toEqual([100])
    expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual([30])
    expect(sum(counts(ledger, 'gfs-ext:resolved:resource:actor:user-session:'))).toBe(30)
    expect(ledgerDenials(ledger, budgets)).toBe(70)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 70,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 120_000)

  it('S2b: each class bucket and the per-IP all-class bucket cap two read classes behind one IP', async () => {
    // Boot-valid: operation (20) <= every read class with mutations, and every
    // read class <= ip (40). pre:ip can only deny when several classes share
    // the IP, because each class alone is capped at its own L first. The two
    // classes carry different budgets, so each bucket must use its own class's.
    const budgets = { resource: 30, proxy: 30, grants: 20, shares: 20, operation: 20, ip: 40 }
    const { send } = await startScenario(budgets)
    const users = await Promise.all(Array.from({ length: 10 }, () => seedUser()))
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        users.flatMap((userId, index) =>
          Array.from({ length: 5 }, () =>
            send(
              index < 5 ? affordancesPath(resourceId) : grantsPath(resourceId),
              sessionToken(userId),
              '198.51.100.40'
            )
          )
        )
      )
    )
    const affordances = run.result.filter(response => response.path.includes('/affordances'))
    const grants = run.result.filter(response => response.path.includes('/grants'))
    expect(affordances).toHaveLength(25)
    expect(grants).toHaveLength(25)
    const affordanceLabels = tally(
      affordances.map(response => classify(response, 'resource-read', budgets))
    )
    const grantStatuses = tally(grants.map(response => String(response.status)))

    // The (grants-read, IP) bucket sees 25 against 20 and denies 5; pre:ip
    // then sees 25 resource + 20 grants = 45 against 40 and denies 5, on
    // either route. On the affordances route only pre:ip can deny.
    const affordances429 = affordanceLabels['postgres:40'] ?? 0
    const grants429 = grantStatuses['429'] ?? 0
    expect(Object.keys(affordanceLabels).sort()).toEqual(
      ['allowed:200', 'postgres:40'].filter(label => affordanceLabels[label] !== undefined)
    )
    expect(Object.keys(grantStatuses).sort()).toEqual(
      ['403', '429'].filter(status => grantStatuses[status] !== undefined)
    )
    expect(affordances429 + grants429).toBe(10)
    expect(grants429).toBeGreaterThanOrEqual(5)
    expect((affordanceLabels['allowed:200'] ?? 0) + (grantStatuses['403'] ?? 0)).toBe(40)
    // "Allowed" is defined per route: the grants list answers 403
    // manage_acl_required for a caller without manage_acl.
    for (const response of grants) {
      if (response.status === 403) expect(response.body.error).toBe('manage_acl_required')
    }
    const ledger = await readLedger()
    expect(counts(ledger, 'gfs-ext:pre:resource:session:')).toEqual(Array(5).fill(5))
    expect(counts(ledger, 'gfs-ext:pre:grants-read:session:')).toEqual(Array(5).fill(5))
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:')).toEqual([25])
    expect(counts(ledger, 'gfs-ext:pre:grants-read:ip:')).toEqual([25])
    expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual([45])
    expect(sum(counts(ledger, 'gfs-ext:resolved:'))).toBe(40)
    // Every grants request that reached the rateLimitMiddleware bucket got a
    // 403: that limiter denied none, and its row is under its limit.
    expect(sum(counts(ledger, 'gfsgrants-ext-read:user:'))).toBe(grantStatuses['403'] ?? 0)
    // The 10 denials are exactly the two Postgres buckets' overflow, and the
    // metric below shows no backstop denial: this is the grants attribution.
    expect(ledgerDenials(ledger, budgets)).toBe(10)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 10,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 120_000)

  it('S3: two sessions of one user share the resolved actor bucket', async () => {
    const budgets = uniformBudgets(10, 10, IP_L_DEFAULT)
    const { send } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all([
        ...Array.from({ length: 8 }, () =>
          send(affordancesPath(resourceId), sessionToken(userId, 1), '198.51.100.51')
        ),
        ...Array.from({ length: 8 }, () =>
          send(affordancesPath(resourceId), sessionToken(userId, 2), '198.51.100.52')
        ),
      ])
    )

    expect(tally(run.result.map(response => classify(response, 'resource-read', budgets)))).toEqual(
      {
        'allowed:200': 10,
        'postgres:10': 6,
      }
    )
    const ledger = await readLedger()
    // Each pre-resolution bucket saw 8 <= 10 and denied nothing; the resolved
    // actor bucket saw all 16: the phase witness, independent of telemetry.
    expect(counts(ledger, 'gfs-ext:pre:resource:session:')).toEqual([8, 8])
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:')).toEqual([8, 8])
    expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual([8, 8])
    expect(counts(ledger, `gfs-ext:resolved:resource:actor:user-session:${userId}`)).toEqual([16])
    expect(ledgerDenials(ledger, budgets)).toBe(6)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 0,
      'resolved-operation': 6,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 120_000)

  it('S4: a burst straddling a minute boundary is denied only by the route backstop', async () => {
    const budgets = uniformBudgets(8, 8, IP_L_DEFAULT)
    const { send, minuteMs } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()
    const burst = () =>
      observed(() =>
        Promise.all(
          Array.from({ length: 8 }, () =>
            send(affordancesPath(resourceId), sessionToken(userId), '198.51.100.60')
          )
        )
      )
    const labelsOf = (responses: Sent[]) =>
      tally(responses.map(response => classify(response, 'resource-read', budgets)))

    // A: 50 s into window 1. Opens the backstop window, fills the Postgres buckets.
    vi.setSystemTime(minuteMs + 50_000)
    const a = await burst()
    // B: 15 s later. New Postgres window (counts 1..8, allowed), same backstop window.
    vi.setSystemTime(minuteMs + 65_000)
    const b = await burst()
    // C: 60 s after A. The session bucket of window 2 is already at 8.
    vi.setSystemTime(minuteMs + 110_000)
    const c = await burst()

    expect(labelsOf(a.result)).toEqual({ 'allowed:200': 8 })
    expect(labelsOf(b.result)).toEqual({ 'route-backstop': 8 })
    expect(labelsOf(c.result)).toEqual({ 'postgres:8': 8 })

    const ledger = await readLedger()
    const window1 = minuteMs
    const window2 = minuteMs + MINUTE_MS
    expect(counts(ledger, 'gfs-ext:pre:resource:session:', window1)).toEqual([8])
    expect(counts(ledger, 'gfs-ext:pre:resource:session:', window2)).toEqual([16])
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:', window1)).toEqual([8])
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:', window2)).toEqual([8])
    expect(counts(ledger, 'gfs-ext:pre:ip:', window1)).toEqual([8])
    expect(counts(ledger, 'gfs-ext:pre:ip:', window2)).toEqual([8])
    expect(counts(ledger, 'gfs-ext:resolved:resource:actor:', window1)).toEqual([8])
    expect(counts(ledger, 'gfs-ext:resolved:resource:actor:', window2)).toEqual([8])
    // Only C's 8 denials are Postgres denials; B's 8 are the backstop's.
    expect(ledgerDenials(ledger, budgets)).toBe(8)

    // S6: A is the liveness witness (allowed, nothing reported); B is reported
    // only as edge-backstop; C only as pre-resolution.
    for (const run of [a, b, c]) expect(run.dbErrors).toBe(0)
    expect(a.metricDelta).toEqual({
      'pre-resolution': 0,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(b.metricDelta).toEqual({
      'pre-resolution': 0,
      'resolved-operation': 0,
      'edge-backstop': 8,
    })
    expect(c.metricDelta).toEqual({
      'pre-resolution': 8,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    for (const run of [a, c]) expect(run.logged).toEqual(run.metricDelta)
    // The backstop logs once per key per window and counts every denial: B's
    // 8 denials share one actor key and one backstop window, so one line.
    expect(b.logged).toEqual({
      'pre-resolution': 0,
      'resolved-operation': 0,
      'edge-backstop': 1,
    })
  }, 120_000)

  it('E1: 481 concurrent reads by one actor at the production budget: 480 allowed, one Postgres 429, no 503', async () => {
    const budgets = PRODUCTION_BUDGETS
    const { send } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        Array.from({ length: 481 }, () =>
          send(affordancesPath(resourceId), sessionToken(userId), '198.51.100.70')
        )
      )
    )

    // Exact: a 503 from either pool or any other status fails here.
    expect(tally(run.result.map(response => classify(response, 'resource-read', budgets)))).toEqual(
      { 'allowed:200': 480, 'postgres:480': 1 }
    )
    const ledger = await readLedger()
    expect(counts(ledger, 'gfs-ext:pre:resource:session:')).toEqual([481])
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:')).toEqual([480])
    expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual([480])
    expect(counts(ledger, `gfs-ext:resolved:resource:actor:user-session:${userId}`)).toEqual([480])
    expect(ledgerDenials(ledger, budgets)).toBe(1)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 1,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 120_000)

  it('E2: a burst straddling a minute boundary passes 2L-1 = 959 reads in 60 s; the next is a Postgres 429', async () => {
    const budgets = PRODUCTION_BUDGETS
    const { send, minuteMs } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()
    const boundary = minuteMs + 2 * MINUTE_MS
    const burstAt = async (atMs: number, size: number) => {
      vi.setSystemTime(atMs)
      const responses = await Promise.all(
        Array.from({ length: size }, () =>
          send(affordancesPath(resourceId), sessionToken(userId), '198.51.100.71')
        )
      )
      return responses.map(response => ({
        atMs,
        label: classify(response, 'resource-read', budgets),
      }))
    }

    const run = await observed(async () => [
      // Opens the backstop window at M:00.0, so it resets at M+1:00.0.
      ...(await burstAt(boundary - MINUTE_MS, 1)),
      ...(await burstAt(boundary - 100, 479)),
      ...(await burstAt(boundary, 480)),
      ...(await burstAt(boundary, 1)),
    ])

    expect(tally(run.result.map(sent => sent.label))).toEqual({
      'allowed:200': 960,
      'postgres:480': 1,
    })
    // The sliding bound: in the 60 s ending at M+1:00.0, 959 reads passed.
    expect(
      run.result.filter(
        sent =>
          sent.label === 'allowed:200' && sent.atMs > boundary - MINUTE_MS && sent.atMs <= boundary
      )
    ).toHaveLength(959)
    expect(run.result[run.result.length - 1]?.label).toBe('postgres:480')
    const ledger = await readLedger()
    const before = boundary - MINUTE_MS
    expect(counts(ledger, 'gfs-ext:pre:resource:session:', before)).toEqual([480])
    expect(counts(ledger, 'gfs-ext:pre:resource:session:', boundary)).toEqual([481])
    expect(counts(ledger, 'gfs-ext:resolved:resource:actor:', before)).toEqual([480])
    expect(counts(ledger, 'gfs-ext:resolved:resource:actor:', boundary)).toEqual([480])
    expect(ledgerDenials(ledger, budgets)).toBe(1)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 1,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 120_000)

  it('E3: 91 mutations by one actor at the production operation budget: 90 reach gfsc, the 91st is a Postgres 429', async () => {
    const budgets = PRODUCTION_BUDGETS
    const { send } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()
    // The only boundary mock: the fetch from control-api to gfsc.
    const gfscFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: randomUUID() }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', gfscFetch)
    try {
      const run = await observed(() =>
        Promise.all(
          Array.from({ length: 91 }, () =>
            send(childrenPath(resourceId), sessionToken(userId), '198.51.100.72', {
              body: { name: 'stress', kind: 'folder' },
            })
          )
        )
      )

      expect(
        tally(run.result.map(response => classify(response, 'resource-mutation', budgets)))
      ).toEqual({ 'allowed:201': 90, 'postgres:90': 1 })
      // Witness: exactly the 90 admitted mutations reached gfsc, each as the
      // POST the route proxies.
      expect(gfscFetch).toHaveBeenCalledTimes(90)
      const target =
        `${mod.config.gfscWriteBaseUrl.replace(/\/+$/, '')}` +
        `/v1/resources/${resourceId.replace(/-/g, '')}/children`
      for (const [url, init] of gfscFetch.mock.calls) {
        expect(String(url)).toBe(target)
        expect(init?.method).toBe('POST')
      }
      const ledger = await readLedger()
      expect(counts(ledger, 'gfs-ext:pre:resource-mutation:session:')).toEqual([91])
      expect(counts(ledger, 'gfs-ext:pre:resource-mutation:ip:')).toEqual([90])
      expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual([90])
      expect(
        counts(ledger, `gfs-ext:resolved:resource-mutation:actor:user-session:${userId}`)
      ).toEqual([90])
      expect(ledgerDenials(ledger, budgets)).toBe(1)
      expect(run.dbErrors).toBe(0)
      expect(run.metricDelta).toEqual({
        'pre-resolution': 1,
        'resolved-operation': 0,
        'edge-backstop': 0,
      })
      expect(run.logged).toEqual(run.metricDelta)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 120_000)

  /**
   * Replays DESKTOP_READS_2026_09_18 serially, one actor, one session, one IP
   * (the upper bound on any one actor's count), each read at its offset on a
   * fresh fake UTC day. Denials are labelled with their UTC second.
   */
  async function replayDesktopDay(budgets: Budgets) {
    const { send, minuteMs: dayStartMs } = await startScenario(
      budgets,
      DAY_MS + 5 * MINUTE_MS,
      DAY_MS
    )
    const userId = await seedUser()
    const resourceId = randomUUID()
    const denials: string[] = []
    const run = await observed(async () => {
      const labels: string[] = []
      for (const offsetMs of DESKTOP_READS_2026_09_18) {
        vi.setSystemTime(dayStartMs + offsetMs)
        const response = await send(
          affordancesPath(resourceId),
          sessionToken(userId),
          '198.51.100.80'
        )
        const label = classify(response, 'resource-read', budgets)
        labels.push(label)
        if (!label.startsWith('allowed:')) {
          denials.push(`${label}@${new Date(offsetMs).toISOString().slice(11, 19)}`)
        }
      }
      return labels
    })
    return { ...run, denials, userId }
  }

  it('E4: the 1965 Desktop reads of 2026-09-18 replayed at the production budget get no 429 and no 503', async () => {
    expect(DESKTOP_READS_2026_09_18).toHaveLength(1965)
    expect(
      DESKTOP_READS_2026_09_18.every((offset, i, all) => i === 0 || all[i - 1]! <= offset)
    ).toBe(true)
    const budgets = PRODUCTION_BUDGETS

    const run = await replayDesktopDay(budgets)

    expect(tally(run.result)).toEqual({ 'allowed:200': 1965 })
    expect(run.denials).toEqual([])
    // Witness that the limiter counted the whole day, including its busiest
    // calendar minute (125 reads).
    const ledger = await readLedger()
    expect(sum(counts(ledger, 'gfs-ext:pre:resource:session:'))).toBe(1965)
    expect(Math.max(...counts(ledger, 'gfs-ext:pre:resource:session:'))).toBe(125)
    expect(sum(counts(ledger, `gfs-ext:resolved:resource:actor:user-session:${run.userId}`))).toBe(
      1965
    )
    expect(ledgerDenials(ledger, budgets)).toBe(0)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 0,
      'resolved-operation': 0,
      'edge-backstop': 0,
    })
    expect(run.logged).toEqual(run.metricDelta)
  }, 300_000)

  it('E4 control: the same replay at the old 120 budget reproduces the 28 production denials at their seconds', async () => {
    // The 28 × 429 served on cluster clerum on 2026-09-18, by UTC second and
    // limiter: nginx statuses give the seconds, the external_gfs_rate_limit
    // events give the Postgres phase of the five at 13:06:59.
    const observedDenials = [
      ...Array<string>(10).fill('route-backstop@04:46:20'),
      ...Array<string>(5).fill('postgres:120@13:06:59'),
      ...Array<string>(7).fill('route-backstop@14:18:15'),
      'route-backstop@14:18:18',
      'route-backstop@14:18:22',
      ...Array<string>(3).fill('route-backstop@14:18:36'),
      'route-backstop@14:18:47',
    ]
    const budgets = { ...PRODUCTION_BUDGETS, resource: 120 }

    const run = await replayDesktopDay(budgets)

    expect(run.denials).toEqual(observedDenials)
    expect(tally(run.result)).toEqual({
      'allowed:200': 1937,
      'postgres:120': 5,
      'route-backstop': 23,
    })
    const ledger = await readLedger()
    expect(ledgerDenials(ledger, budgets)).toBe(5)
    expect(run.dbErrors).toBe(0)
    expect(run.metricDelta).toEqual({
      'pre-resolution': 5,
      'resolved-operation': 0,
      'edge-backstop': 23,
    })
    // The backstop logs once per key per window: its 23 denials fall in two
    // windows (04:46 and 14:18).
    expect(run.logged).toEqual({
      'pre-resolution': 5,
      'resolved-operation': 0,
      'edge-backstop': 2,
    })
  }, 300_000)
})
