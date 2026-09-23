import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'

// Concurrent users at the external GFS rate limits, through the production
// Express app against real PostgreSQL. Config, the core pool, both limiters,
// the session lifecycle query, authority resolution, the prom registry and the
// logger are real; the ONLY mock is the session-token verifier (identity),
// which decodes a JSON test token so each scenario controls users and sessions.
//
// Denial source (plan Addendum A3), for status 429 only:
// - route backstop: RateLimit-Policy === "<route L>;w=60";
// - Postgres bucket: RateLimit-Policy === "<ingress L>;w=60" AND
//   X-RateLimit-Remaining === "0" AND X-RateLimit-Limit === "<bucket L>";
// - anything else fails the test.
// Headers cannot say WHICH Postgres bucket denied, so every scenario also reads
// the rate_limit_buckets ledger: each hit increments its row once and a bucket
// only sees requests that passed the buckets before it, so per (key, window)
// denials = max(0, count - limit). The key prefix names the phase.
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

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type Budgets = { read: number; operation: number; ip: number }
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
  const envKeys = ['CONTROL_API_PG_CONNECTION_STRING', 'CORE_POOL_CONNECTION_TIMEOUT_MS'] as const
  const previousEnv = new Map<string, string | undefined>()

  let adminPool: Pool
  let corePool: Pool
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    assertExternalGfsBudgetInvariants: typeof import('../src/config.js').assertExternalGfsBudgetInvariants
    pool: import('../src/db.js').DbClient
    rootLogger: typeof import('../src/observability/logger.js').rootLogger
    requestsTotal: typeof import('../src/observability/metrics.js').externalGfsRateLimitRequestsTotal
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }
  // Forward-only fake clock: every scenario starts on a later minute.
  let nextScenarioMinuteMs = 0

  beforeAll(async () => {
    if (adminUrl === undefined) {
      throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required by this suite')
    }
    const connectionString = databaseUrl(adminUrl, database)
    for (const key of envKeys) previousEnv.set(key, process.env[key])
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
    // A 200-request burst queues on 10 connections; the production 2 s acquire
    // timeout would make the limiter fail open by accident (see
    // services.rateLimiterPoolSaturation.realPostgres.integration.test.ts).
    process.env.CORE_POOL_CONNECTION_TIMEOUT_MS = '10000'

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
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
      MockGateway,
    }
    expect(mod.config.externalGfsIngressRlPerMin).toBe(INGRESS_L)
    expect(mod.config.externalGfsIpRlPerMin).toBe(IP_L_DEFAULT)
    vi.useFakeTimers({ toFake: ['Date'] })
    nextScenarioMinuteMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + 10 * MINUTE_MS
  }, 60_000)

  afterAll(async () => {
    vi.useRealTimers()
    for (const key of envKeys) {
      const value = previousEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await corePool?.end().catch(() => {})
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  /** Sets a boot-valid budget, clears the ledger, returns a fresh app and the scenario minute. */
  async function startScenario(budgets: Budgets) {
    mod.assertExternalGfsBudgetInvariants({
      readPerMin: budgets.read,
      operationPerMin: budgets.operation,
      ipPerMin: budgets.ip,
    })
    mod.config.externalGfsReadRlPerMin = budgets.read
    mod.config.externalGfsOperationRlPerMin = budgets.operation
    mod.config.externalGfsIpRlPerMin = budgets.ip
    await mod.pool.query('DELETE FROM rate_limit_buckets')
    const minuteMs = nextScenarioMinuteMs
    nextScenarioMinuteMs += 5 * MINUTE_MS
    vi.setSystemTime(minuteMs + 10_000)
    return { app: mod.createApp(new mod.MockGateway()), minuteMs }
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

  async function send(
    app: import('express').Express,
    path: string,
    token: string,
    ip: string
  ): Promise<Sent> {
    const internalToken = mod.config.internalServiceTokens['external-rest-api']
    if (!internalToken) throw new Error('config has no external-rest-api internal service token')
    const res = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${internalToken}`)
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', token)
      .set('x-forwarded-for', ip)
    return {
      path,
      status: res.status,
      body: res.body as { error?: unknown },
      policy: res.headers['ratelimit-policy'],
      xLimit: res.headers['x-ratelimit-limit'],
      xRemaining: res.headers['x-ratelimit-remaining'],
    }
  }

  /** Addendum A3 classifier. Allowed responses keep their status. */
  function classify(response: Sent, routeL: number): string {
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
    if (/^gfs-ext:(pre|resolved):(resource|grants-read):/.test(key)) return budgets.read
    if (key.startsWith('gfsgrants-ext-read:user:')) return budgets.read
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

  /** Captures denial log lines by phase and every limiter DB error during `run`. */
  async function observed<T>(run: () => Promise<T>) {
    const warn = vi.spyOn(mod.rootLogger, 'warn').mockImplementation(() => {})
    const before = await deniedByPhase()
    try {
      const result = await run()
      const after = await deniedByPhase()
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
        dbErrors: payloads.filter(p => p.event === 'rate_limit_db_error').length,
      }
    } finally {
      warn.mockRestore()
    }
  }

  it('S1: 20 users with distinct sessions and IPs each get exactly the read budget', async () => {
    const budgets = { read: 6, operation: 6, ip: IP_L_DEFAULT }
    const { app } = await startScenario(budgets)
    const users = await Promise.all(Array.from({ length: 20 }, () => seedUser()))
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        users.flatMap((userId, index) =>
          Array.from({ length: 10 }, () =>
            send(app, affordancesPath(resourceId), sessionToken(userId), `198.51.100.${index + 1}`)
          )
        )
      )
    )
    const labels = run.result.map(response => classify(response, budgets.read))

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
    const budgets = { read: 30, operation: 30, ip: IP_L_DEFAULT }
    const { app } = await startScenario(budgets)
    const users = await Promise.all(Array.from({ length: 20 }, () => seedUser()))
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        users.flatMap(userId =>
          Array.from({ length: 5 }, () =>
            send(app, affordancesPath(resourceId), sessionToken(userId), '198.51.100.30')
          )
        )
      )
    )

    expect(tally(run.result.map(response => classify(response, budgets.read)))).toEqual({
      'allowed:200': 30,
      'postgres:30': 70,
    })
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

  it('S2b: the per-IP all-class bucket caps two read classes behind one IP', async () => {
    // Boot-valid: read (30) <= ip (40). pre:ip can only deny when several
    // classes share the IP, because each class alone is capped at read L first.
    const budgets = { read: 30, operation: 30, ip: 40 }
    const { app } = await startScenario(budgets)
    const users = await Promise.all(Array.from({ length: 10 }, () => seedUser()))
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all(
        users.flatMap((userId, index) =>
          Array.from({ length: 5 }, () =>
            send(
              app,
              index < 5 ? affordancesPath(resourceId) : grantsPath(resourceId),
              sessionToken(userId),
              '198.51.100.40'
            )
          )
        )
      )
    )
    const labels = run.result.map(response => classify(response, budgets.read))
    const tallied = tally(labels)

    expect(tallied['postgres:40']).toBe(10)
    expect((tallied['allowed:200'] ?? 0) + (tallied['allowed:403'] ?? 0)).toBe(40)
    expect(Object.keys(tallied).sort()).toEqual(
      ['allowed:200', 'allowed:403', 'postgres:40'].filter(label => tallied[label] !== undefined)
    )
    // "Allowed" is defined per route: affordances answer 200, the grants list
    // answers 403 manage_acl_required for a caller without manage_acl.
    for (const response of run.result) {
      if (response.status === 200) expect(response.path).toContain('/affordances')
      if (response.status === 403) {
        expect(response.path).toContain('/grants')
        expect(response.body.error).toBe('manage_acl_required')
      }
    }
    const ledger = await readLedger()
    expect(counts(ledger, 'gfs-ext:pre:resource:session:')).toEqual(Array(5).fill(5))
    expect(counts(ledger, 'gfs-ext:pre:grants-read:session:')).toEqual(Array(5).fill(5))
    expect(counts(ledger, 'gfs-ext:pre:resource:ip:')).toEqual([25])
    expect(counts(ledger, 'gfs-ext:pre:grants-read:ip:')).toEqual([25])
    expect(counts(ledger, 'gfs-ext:pre:ip:')).toEqual([50])
    expect(sum(counts(ledger, 'gfs-ext:resolved:'))).toBe(40)
    expect(sum(counts(ledger, 'gfsgrants-ext-read:user:'))).toBe(tallied['allowed:403'] ?? 0)
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
    const budgets = { read: 10, operation: 10, ip: IP_L_DEFAULT }
    const { app } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()

    const run = await observed(() =>
      Promise.all([
        ...Array.from({ length: 8 }, () =>
          send(app, affordancesPath(resourceId), sessionToken(userId, 1), '198.51.100.51')
        ),
        ...Array.from({ length: 8 }, () =>
          send(app, affordancesPath(resourceId), sessionToken(userId, 2), '198.51.100.52')
        ),
      ])
    )

    expect(tally(run.result.map(response => classify(response, budgets.read)))).toEqual({
      'allowed:200': 10,
      'postgres:10': 6,
    })
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
    const budgets = { read: 8, operation: 8, ip: IP_L_DEFAULT }
    const { app, minuteMs } = await startScenario(budgets)
    const userId = await seedUser()
    const resourceId = randomUUID()
    const burst = () =>
      observed(() =>
        Promise.all(
          Array.from({ length: 8 }, () =>
            send(app, affordancesPath(resourceId), sessionToken(userId), '198.51.100.60')
          )
        )
      )
    const labelsOf = (responses: Sent[]) =>
      tally(responses.map(response => classify(response, budgets.read)))

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
})
