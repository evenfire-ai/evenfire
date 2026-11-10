import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createServer } from 'node:http'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { mcpHostJwtRefreshTotal } from '../src/observability/metrics.js'
import { issueMcpHostRefreshJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/utils/auth/mcpHostJwtToken.js', async () =>
  vi.importActual<typeof import('../src/utils/auth/mcpHostJwtToken.js')>(
    '../src/utils/auth/mcpHostJwtToken.js'
  )
)
vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

// DB pool is now called for TWO things by the refresh endpoint:
//   1. rate_limit_buckets INSERT ... RETURNING count  (rate limiter middleware)
//   2. workflow_revoked_refresh_jtis SELECT / INSERT   (JTI verify, then consumption)
// The mock dispatches on SQL fragment so each call returns the right shape.
const rateLimitCounts = new Map<string, number>()
const consumedJtis = new Set<string>()
// Number of upcoming revocation SELECTs that fail as a lost database connection.
let failingRevocationSelects = 0
// While set, every revocation SELECT waits for it before answering.
let selectGate: Promise<void> | null = null
const mockPoolQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/rate_limit_buckets/i.test(text)) {
    // Key on (bucketKey, windowStartMs) to match the real PG unique index.
    // Without the windowStartMs, rollover tests can't observe a fresh window.
    const bucketKey = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : 'unknown'
    const windowStart = Array.isArray(params) && typeof params[1] === 'number' ? params[1] : 0
    const key = `${bucketKey}|${windowStart}`
    const next = (rateLimitCounts.get(key) ?? 0) + 1
    rateLimitCounts.set(key, next)
    return { rows: [{ count: next }], rowCount: 1 }
  }
  if (/workflow_revoked_refresh_jtis/i.test(text)) {
    const jti =
      Array.isArray(params) && typeof params[0] === 'string'
        ? params[0]
        : `unknown-${mockPoolQuery.mock.calls.length}`
    // The route verifies (SELECT, read-only) before it consumes (INSERT).
    if (/^\s*SELECT/i.test(text)) {
      if (selectGate) await selectGate
      if (failingRevocationSelects > 0) {
        failingRevocationSelects -= 1
        throw new Error('connection lost')
      }
      const hit = consumedJtis.has(jti)
      return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 }
    }
    if (consumedJtis.has(jti)) {
      return { rows: [], rowCount: 0 }
    }
    consumedJtis.add(jti)
    return { rows: [{ jti }], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
})

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(args[0], args[1] as unknown[] | undefined),
    connect: vi.fn(),
  },
  rateLimitPool: {
    query: (...args: unknown[]) => mockPoolQuery(args[0], args[1] as unknown[] | undefined),
  },
  withTransaction: vi.fn(),
}))

describe('Workflow approval refresh rate limit', () => {
  let app: ReturnType<typeof createApp>

  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitCounts.clear()
    consumedJtis.clear()
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('does not consume a refresh token when the request is rate limited', async () => {
    const limit = config.approvalRlRefreshPerMin
    // Pin the fixed-window clock before warm-up, including near a minute boundary.
    const baseNow = Math.floor(Date.now() / 60_000) * 60_000 + 10_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow)
    // Warm up exactly `limit` calls with unique refresh tokens — all should 200.
    for (let i = 0; i < limit; i++) {
      const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${token}`)
        .send()
      expect(res.status).toBe(200)
    }

    // (limit+1)-th call with a fresh probe token → rate limit middleware rejects
    // BEFORE the JTI consumption query runs.
    const { token: probeToken } = issueMcpHostRefreshJwt('ns', 'recipe')
    const rateLimited = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${probeToken}`)
      .send()
    expect(rateLimited.status).toBe(429)

    // Rollover the 60s window so the limiter grants a fresh slot. The
    // rateLimiterService uses `Date.now()` internally — spy on it so we don't
    // actually wait a minute in the test.
    nowSpy.mockReturnValue(baseNow + 60_001)

    try {
      const retried = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${probeToken}`)
        .send()
      expect(retried.status).toBe(200)
      expect(retried.body.refreshToken).toBeDefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not let unsigned refresh claims poison a recipe rate-limit bucket', async () => {
    const forged = jwt.sign(
      {
        sub: 'ns/recipe',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        hostRefs: ['ns/recipe'],
        scope: 'workflow:approval:refresh',
      },
      'attacker-controlled-secret',
      {
        algorithm: 'HS256',
        issuer: config.adminJwtIssuer,
        audience: 'workflow-approvals',
        expiresIn: 300,
        jwtid: 'forged-refresh-jti',
      }
    )

    for (let i = 0; i < config.approvalRlRefreshPerMin + 1; i++) {
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${forged}`)
        .send()
      expect(res.status).toBe(401)
    }

    const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
    const valid = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()

    expect(valid.status).toBe(200)
  })
})

describe('Workflow approval refresh: database failure during verification', () => {
  let app: ReturnType<typeof createApp>

  const isRevocationSelect = (sql: unknown): boolean =>
    typeof sql === 'string' && /workflow_revoked_refresh_jtis/i.test(sql) && /^\s*SELECT/i.test(sql)
  const revocationSelectsFor = (jti: string): number =>
    mockPoolQuery.mock.calls.filter(
      ([sql, params]) => isRevocationSelect(sql) && Array.isArray(params) && params[0] === jti
    ).length

  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitCounts.clear()
    consumedJtis.clear()
    failingRevocationSelects = 0
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('answers 5xx, not 401, and leaves the token unconsumed when the revocation lookup fails', async () => {
    const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
    const jti = (jwt.decode(token) as jwt.JwtPayload).jti as string
    failingRevocationSelects = 1

    const failed = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()

    expect(failed.status).toBeGreaterThanOrEqual(500)
    // Witness: the lookup that failed was really issued for this token.
    expect(revocationSelectsFor(jti)).toBe(1)
    expect(failingRevocationSelects).toBe(0)
    expect(consumedJtis.has(jti)).toBe(false)

    // The same token still renews once the database answers again.
    const retried = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()
    expect(retried.status).toBe(200)
    expect(retried.body.refreshToken).toBeDefined()
    expect(consumedJtis.has(jti)).toBe(true)
  })

  it('still answers 401 for a refresh token whose jti is already revoked', async () => {
    const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
    const jti = (jwt.decode(token) as jwt.JwtPayload).jti as string
    // Seed the revocation row directly: no request in this process consumed it.
    consumedJtis.add(jti)

    const res = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()

    expect(res.status).toBe(401)
    // Witness: the answer came from the database lookup, not from the token checks.
    expect(revocationSelectsFor(jti)).toBe(1)
  })

  it('still answers 401 for a badly signed refresh token without querying revocations', async () => {
    const forged = jwt.sign(
      {
        sub: 'ns/recipe',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        hostRefs: ['ns/recipe'],
        scope: 'workflow:approval:refresh',
      },
      'attacker-controlled-secret',
      {
        algorithm: 'HS256',
        issuer: config.adminJwtIssuer,
        audience: 'workflow-approvals',
        expiresIn: 300,
        jwtid: 'forged-refresh-jti-db',
      }
    )

    const res = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${forged}`)
      .send()

    // Witness: the route answered and rejected the credential.
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(mockPoolQuery.mock.calls.filter(([sql]) => isRevocationSelect(sql))).toHaveLength(0)
  })
})

describe('Workflow approval refresh: caller gone before the consume', () => {
  let app: ReturnType<typeof createApp>
  let release: (() => void) | null = null

  const isRevocationTable = (sql: unknown): boolean =>
    typeof sql === 'string' && /workflow_revoked_refresh_jtis/i.test(sql)
  const isSelect = (sql: unknown): boolean => typeof sql === 'string' && /^\s*SELECT/i.test(sql)
  const callsFor = (jti: string, select: boolean): number =>
    mockPoolQuery.mock.calls.filter(
      ([sql, params]) =>
        isRevocationTable(sql) &&
        isSelect(sql) === select &&
        Array.isArray(params) &&
        params[0] === jti
    ).length
  const refreshCount = async (result: string): Promise<number> => {
    const metric = await mcpHostJwtRefreshTotal.get()
    return metric.values.find(v => v.labels.result === result)?.value ?? 0
  }
  const holdRevocationSelects = (): void => {
    selectGate = new Promise<void>(resolve => {
      release = resolve
    })
  }

  afterEach(() => {
    // A failing run must not leave later requests waiting on the gate.
    selectGate = null
    release?.()
    release = null
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitCounts.clear()
    consumedJtis.clear()
    failingRevocationSelects = 0
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('leaves the token unconsumed when the caller closed the connection before the consume', async () => {
    const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
    const jti = (jwt.decode(token) as jwt.JwtPayload).jti as string
    const server = createServer(app)
    // Resolves when the server side of the request sees its response close,
    // which is when `res.closed` becomes true in the route.
    const closedSeen = new Promise<void>(resolve => {
      server.on('request', (_req, res) => res.once('close', () => resolve()))
    })
    const callerGoneBefore = await refreshCount('caller_gone')
    const successBefore = await refreshCount('success')
    holdRevocationSelects()

    // The caller gives up while the revocation lookup is held, as the gateway
    // does at its read timeout.
    await expect(
      request(server)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${token}`)
        .timeout(200)
        .send()
    ).rejects.toThrow()
    // Witness: the request reached the lookup that is held.
    await vi.waitFor(() => expect(callsFor(jti, true)).toBe(1))
    await closedSeen
    release?.()

    // Witness: the route resumed after the release and recorded its outcome.
    await vi.waitFor(async () =>
      expect(await refreshCount('caller_gone')).toBe(callerGoneBefore + 1)
    )
    expect(await refreshCount('success')).toBe(successBefore)
    expect(callsFor(jti, false)).toBe(0)
    expect(consumedJtis.has(jti)).toBe(false)

    // The same token still renews on the next attempt.
    selectGate = null
    const retried = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()
    expect(retried.status).toBe(200)
    expect(retried.body.refreshToken).toBeDefined()
    expect(callsFor(jti, false)).toBe(1)
    expect(consumedJtis.has(jti)).toBe(true)
  })

  it('leaves the token unconsumed when the caller closed the connection during the Host lookup', async () => {
    const gateway = new MockGateway('mcp-server')
    const hostName = 'chatllm'
    const host = (await gateway.createResource(
      'hosts',
      {
        metadata: { name: hostName },
        spec: { host: hostName, contextRef: 'ctx-a', secretRef: `${hostName}-llm` },
      },
      config.hostsNamespace
    )) as { metadata: { uid: string } }
    // An HCC-lineage token: the route looks up its Host after the revocation check.
    const { token } = issueMcpHostRefreshJwt(config.hostsNamespace, 'standalone', [hostName], {
      workflowControlScopes: ['workflow:list'],
      hccCredential: { hostUid: host.metadata.uid },
    })
    const jti = (jwt.decode(token) as jwt.JwtPayload).jti as string
    // Hold the Host lookup, not the revocation lookup, until released.
    const lookupGate = new Promise<void>(resolve => {
      release = resolve
    })
    const readHost = gateway.getResource.bind(gateway)
    const hostLookup = vi
      .spyOn(gateway, 'getResource')
      .mockImplementation(async (plural, name, namespace) => {
        await lookupGate
        return readHost(plural, name, namespace)
      })
    const hostApp = createApp(gateway as never)
    const server = createServer(hostApp)
    // Resolves when the server side of the request sees its response close,
    // which is when `res.closed` becomes true in the route.
    const closedSeen = new Promise<void>(resolve => {
      server.on('request', (_req, res) => res.once('close', () => resolve()))
    })
    const callerGoneBefore = await refreshCount('caller_gone')
    const successBefore = await refreshCount('success')

    // The caller gives up while the Host lookup is held, as the gateway does
    // at its read timeout.
    await expect(
      request(server)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${token}`)
        .timeout(200)
        .send()
    ).rejects.toThrow()
    // Witnesses: the revocation lookup answered and the request reached the
    // Host lookup that is held.
    await vi.waitFor(() => expect(hostLookup).toHaveBeenCalledTimes(1))
    expect(hostLookup).toHaveBeenCalledWith('hosts', hostName, config.hostsNamespace)
    expect(callsFor(jti, true)).toBe(1)
    await closedSeen
    release?.()

    // Witness: the route resumed after the release and recorded its outcome.
    await vi.waitFor(async () =>
      expect(await refreshCount('caller_gone')).toBe(callerGoneBefore + 1)
    )
    expect(await refreshCount('success')).toBe(successBefore)
    expect(callsFor(jti, false)).toBe(0)
    expect(consumedJtis.has(jti)).toBe(false)

    // The same token still renews on the next attempt, so the Host binding was valid.
    const retried = await request(hostApp)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send()
    expect(retried.status).toBe(200)
    expect(retried.body.refreshToken).toBeDefined()
    expect(hostLookup).toHaveBeenCalledTimes(2)
    expect(callsFor(jti, false)).toBe(1)
    expect(consumedJtis.has(jti)).toBe(true)
  })

  it('consumes the token when the held lookup answers while the caller is still connected', async () => {
    const { token } = issueMcpHostRefreshJwt('ns', 'recipe')
    const jti = (jwt.decode(token) as jwt.JwtPayload).jti as string
    holdRevocationSelects()

    // Started before the release, so the caller is connected when the lookup answers.
    const pending = request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .then(res => res)
    await vi.waitFor(() => expect(callsFor(jti, true)).toBe(1))
    release?.()

    const res = await pending
    expect(res.status).toBe(200)
    expect(res.body.refreshToken).toBeDefined()
    expect(callsFor(jti, false)).toBe(1)
    expect(consumedJtis.has(jti)).toBe(true)
  })
})
