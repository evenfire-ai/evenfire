import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
import { rateLimitHitsTotal } from '../src/observability/metrics.js'
import {
  adminOutputsReadRateLimits,
  adminSubscriptionReadRateLimits,
  adminSubscriptionWriteRateLimits,
  adminWorkflowRateLimitCredential,
  adminWorkflowTriggerRateLimit,
  llmProviderAttemptAuthorizeRateLimits,
  mcpHostAttemptRateLimitKey,
  mcpHostWorkflowTriggerRateLimit,
  mcpHostWorkflowTriggerRateLimitCredential,
  shouldSkipWorkflowGrantEdgeRateLimit,
  subscriptionOAuthCallbackRateLimits,
  verifiedAdminRateLimitSubject,
  workflowAdminReadRateLimits,
  workflowGrantEdgeRateLimitKey,
  workflowGrantReadRateLimit,
  workflowGrantReadRateLimits,
  workflowGrantWriteRateLimits,
  workflowTriggerRateLimit,
  workflowTriggerRateLimitCredential,
} from '../src/routes/workflows/shared/rateLimit.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())
const mockVerifyAdminToken = vi.hoisted(() => vi.fn())
const mockVerifyExternalSessionToken = vi.hoisted(() => vi.fn())

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))
vi.mock('../src/observability/metrics.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/metrics.js')>()
  return {
    ...actual,
    rateLimitHitsTotal: { inc: vi.fn() },
  }
})
vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (token: string) => mockVerifyAdminToken(token),
}))
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (token: string) => mockVerifyExternalSessionToken(token),
}))

function signedClaims(sub: string) {
  return {
    sub,
    typ: 'user' as const,
    role: 'admin' as const,
    jti: 'jti',
    exp: 1,
    sessionVersion: 0,
  }
}

function pgAllows() {
  mockCheckAndIncrement.mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  })
}

describe('routes/workflows/shared/rateLimit', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function countRequests() {
    const counts = new Map<string, number>()
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockImplementation(async (key: string, limit: number) => {
      const windowStartMs = Math.floor(Date.now() / 60_000) * 60_000
      const identity = `${key}|${windowStartMs}`
      const count = (counts.get(identity) ?? 0) + 1
      counts.set(identity, count)
      return {
        allowed: count <= limit,
        backendAvailable: true,
        remaining: Math.max(0, limit - count),
        resetMs: windowStartMs + 60_000,
        windowStartMs,
        count,
      }
    })
    return counts
  }

  it('shares 150 subscription reads across provider routes and recovers at reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    const counts = countRequests()
    const app = express()
    for (const path of ['/codex/connections', '/grok/connections', '/grok/models']) {
      app.get(path, ...adminSubscriptionReadRateLimits(), (_req, res) => res.sendStatus(204))
    }
    const paths = ['/codex/connections', '/grok/connections', '/grok/models']
    for (let i = 0; i < 150; i++) {
      await request(app)
        .get(paths[i % paths.length])
        .set('Cookie', 'control_ui_admin_session=signed-admin-a')
        .expect(204)
    }
    expect(counts.size).toBe(1)
    const denied = await request(app)
      .get(paths[0])
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(429)
    expect(denied.headers['x-ratelimit-limit']).toBe('150')
    expect(denied.headers['retry-after']).toBeDefined()
    vi.setSystemTime(1_800_000_060_000)
    const recovered = await request(app)
      .get(paths[0])
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(204)
    expect(recovered.headers['x-ratelimit-remaining']).toBe('149')
  })

  it('gives distinct verified sessions independent subscription allowances', async () => {
    countRequests()
    const app = express()
    app.get('/connections', ...adminSubscriptionReadRateLimits(), (_req, res) =>
      res.sendStatus(204)
    )
    for (const session of ['signed-admin-a', 'signed-admin-b']) {
      for (let i = 0; i < 150; i++) {
        await request(app)
          .get('/connections')
          .set('Cookie', `control_ui_admin_session=${session}`)
          .expect(204)
      }
    }
    await request(app)
      .get('/connections')
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(429)
  })

  it('aligns edge recovery with the database wall-clock window after a late first request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_030_000)
    mockVerifyAdminToken.mockImplementation(() => signedClaims('window-fixture'))
    countRequests()
    const app = express()
    app.get('/connections', ...adminSubscriptionReadRateLimits(), (_req, res) =>
      res.sendStatus(204)
    )
    const cookie = 'control_ui_admin_session=window-fixture'
    const first = await request(app).get('/connections').set('Cookie', cookie).expect(204)
    expect(first.headers.ratelimit).toMatch(/reset=30\b/)
    for (let i = 1; i < 150; i++)
      await request(app).get('/connections').set('Cookie', cookie).expect(204)
    const denied = await request(app).get('/connections').set('Cookie', cookie).expect(429)
    expect(denied.headers['retry-after']).toBe('30')
    vi.setSystemTime(1_800_000_060_000)
    for (let i = 0; i < 150; i++)
      await request(app).get('/connections').set('Cookie', cookie).expect(204)
    await request(app).get('/connections').set('Cookie', cookie).expect(429)
  })

  it('uses a configured read budget for both edge and distributed gates', async () => {
    const original = config.adminSubscriptionReadPerMin
    config.adminSubscriptionReadPerMin = 3
    try {
      countRequests()
      const app = express()
      app.get('/connections', ...adminSubscriptionReadRateLimits(), (_req, res) =>
        res.sendStatus(204)
      )
      for (let i = 0; i < 3; i++) {
        await request(app)
          .get('/connections')
          .set('Cookie', 'control_ui_admin_session=signed-admin-a')
          .expect(204)
      }
      const denied = await request(app)
        .get('/connections')
        .set('Cookie', 'control_ui_admin_session=signed-admin-a')
        .expect(429)
      expect(denied.headers['ratelimit-policy']).toBe('3;w=60')
      expect(mockCheckAndIncrement.mock.calls.every(call => call[1] === 3)).toBe(true)
    } finally {
      config.adminSubscriptionReadPerMin = original
    }
  })

  it.each(['signed-admin-b', 'unverified-fixture'])(
    'attributes subscription reads to the cookie despite an extra bearer %s',
    async extra => {
      countRequests()
      const app = express()
      app.get('/connections', ...adminSubscriptionReadRateLimits(), (_req, res) =>
        res.sendStatus(204)
      )
      await request(app)
        .get('/connections')
        .set('Cookie', 'control_ui_admin_session=signed-admin-a')
        .set('Authorization', `Bearer ${extra}`)
        .expect(204)
      const expected = createHash('sha256').update('signed-admin-a').digest('hex').slice(0, 32)
      expect(mockCheckAndIncrement.mock.calls[0]?.slice(0, 2)).toEqual([
        `admin_subscription_read:${expected}`,
        150,
      ])
    }
  )

  it('allows 100 subscription writes without consuming the read quota', async () => {
    const counts = countRequests()
    const app = express()
    app.post('/connections', ...adminSubscriptionWriteRateLimits(), (_req, res) =>
      res.sendStatus(204)
    )
    app.get('/connections', ...adminSubscriptionReadRateLimits(), (_req, res) =>
      res.sendStatus(204)
    )
    for (let i = 0; i < 100; i++) {
      await request(app)
        .post('/connections')
        .set('Cookie', 'control_ui_admin_session=signed-admin-a')
        .expect(204)
    }
    await request(app)
      .post('/connections')
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(429)
    await request(app)
      .get('/connections')
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(204)
    expect(counts.size).toBe(2)
  })

  function callbackApp() {
    vi.mocked(rateLimitHitsTotal.inc).mockClear()
    const handled = { count: 0 }
    const app = express()
    app.set('trust proxy', 1)
    app.get('/callback', ...subscriptionOAuthCallbackRateLimits(), (_req, res) => {
      handled.count += 1
      res.sendStatus(204)
    })
    return { app, handled }
  }

  function deniedCallbackBuckets(): unknown[] {
    return vi
      .mocked(rateLimitHitsTotal.inc)
      .mock.calls.filter(([labels]) => (labels as { result?: string }).result === 'denied')
      .map(([labels]) => (labels as { bucket_type?: string }).bucket_type)
  }

  it('enforces the 100 per-state callback budget across source addresses', async () => {
    countRequests()
    const { app, handled } = callbackApp()
    // Each request comes from a different address, so the per-IP ceiling never
    // binds and the denial below can only come from the per-state limiter.
    for (let i = 0; i < 100; i++) {
      await request(app)
        .get('/callback')
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
        .query({ state: 'unit-callback-state' })
        .expect(204)
    }
    const denied = await request(app)
      .get('/callback')
      .set('X-Forwarded-For', '203.0.113.200')
      .query({ state: 'unit-callback-state' })
      .expect(429)
    expect(handled.count).toBe(100)
    expect(deniedCallbackBuckets()).toEqual(['subscription_oauth_callback_edge'])
    expect(denied.headers['ratelimit-policy']).toBe('100;w=60')
    expect(denied.headers['retry-after']).toBeDefined()
  })

  it('bounds state rotation from one source address at the edge without a ledger key', async () => {
    countRequests()
    const { app, handled } = callbackApp()
    for (let i = 0; i < 100; i++) {
      await request(app)
        .get('/callback')
        .set('X-Forwarded-For', '198.51.100.7')
        .query({ state: `rotated-state-${i}` })
        .expect(204)
    }
    const denied = await request(app)
      .get('/callback')
      .set('X-Forwarded-For', '198.51.100.7')
      .query({ state: 'rotated-state-100' })
      .expect(429)
    expect(denied.body.code).toBe('rate_limited')
    expect(handled.count).toBe(100)
    expect(deniedCallbackBuckets()).toEqual(['subscription_oauth_callback_ip_ceiling_edge'])
    // Every admitted request reached the ledger, keyed by its state; the
    // ceiling key never did.
    const ledgerKeys = mockCheckAndIncrement.mock.calls.map(call => String(call[0]))
    expect(ledgerKeys).toHaveLength(100)
    expect(ledgerKeys.every(key => key.startsWith('subscription_oauth_callback:state:'))).toBe(true)

    // Another source address keeps its own ceiling.
    await request(app)
      .get('/callback')
      .set('X-Forwarded-For', '198.51.100.8')
      .query({ state: 'rotated-state-other-ip' })
      .expect(204)
    expect(handled.count).toBe(101)
  })

  it('counts a caller-prepended forwarding address against the real source address', async () => {
    countRequests()
    const { app, handled } = callbackApp()
    for (let i = 0; i < 100; i++) {
      await request(app)
        .get('/callback')
        .set('X-Forwarded-For', '198.51.100.9')
        .query({ state: `spoof-state-${i}` })
        .expect(204)
    }
    await request(app)
      .get('/callback')
      .set('X-Forwarded-For', '9.9.9.9, 198.51.100.9')
      .query({ state: 'spoof-state-100' })
      .expect(429)
    expect(handled.count).toBe(100)
    expect(deniedCallbackBuckets()).toEqual(['subscription_oauth_callback_ip_ceiling_edge'])
  })

  it.each([
    ['workflow grant reads', 300, workflowGrantReadRateLimits],
    ['workflow grant writes', 100, workflowGrantWriteRateLimits],
    ['workflow administrative reads', 300, workflowAdminReadRateLimits],
    ['administrative output reads', 150, adminOutputsReadRateLimits],
  ] as const)(
    'allows the increased %s capacity through both gates',
    async (_family, limit, factory) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_800_000_000_000)
      mockVerifyAdminToken.mockImplementation(() => signedClaims('capacity-fixture'))
      countRequests()
      const app = express()
      app.get('/capacity', ...factory(), (_req, res) => res.sendStatus(204))
      const cookie = 'control_ui_admin_session=capacity-fixture'
      for (let i = 0; i < limit; i++) {
        await request(app).get('/capacity').set('Cookie', cookie).expect(204)
      }
      const denied = await request(app).get('/capacity').set('Cookie', cookie).expect(429)
      expect(denied.body.code).toBe('rate_limited')
      expect(denied.headers['retry-after']).toBeDefined()
      expect(mockCheckAndIncrement.mock.calls.every(call => call[1] === limit)).toBe(true)
    }
  )

  it('retains the 20-request callback IP safeguard when no state is supplied', async () => {
    countRequests()
    const { app, handled } = callbackApp()
    for (let i = 0; i < 20; i++) await request(app).get('/callback').expect(204)
    await request(app).get('/callback').expect(429)
    expect(handled.count).toBe(20)
    expect(deniedCallbackBuckets()).toEqual(['subscription_oauth_callback_edge'])
    expect(mockCheckAndIncrement.mock.calls.every(call => call[1] === 20)).toBe(true)
    // The no-state safeguard and the per-IP ceiling are separate buckets: the
    // same address can still complete a callback that carries a state.
    await request(app).get('/callback').query({ state: 'after-no-state' }).expect(204)
    expect(handled.count).toBe(21)
  })

  // The Postgres gate is the counter shared across replicas, so it must enforce
  // the unverified budget on its own. Rotation tests stop at the edge limiter
  // first and never observe the limit this gate receives.
  it.each([
    [
      'workflow grant read',
      () => workflowGrantReadRateLimits()[1],
      60,
      () => config.adminWorkflowGrantReadPerMin,
    ],
    [
      'workflow grant write',
      () => workflowGrantWriteRateLimits()[1],
      20,
      () => config.adminWorkflowGrantWritePerMin,
    ],
    [
      'workflow administrative read',
      () => workflowAdminReadRateLimits()[1],
      60,
      () => config.adminWorkflowReadPerMin,
    ],
    [
      'administrative output read',
      () => adminOutputsReadRateLimits()[1],
      30,
      () => config.adminOutputsReadPerMin,
    ],
    [
      'subscription read',
      () => adminSubscriptionReadRateLimits()[1],
      30,
      () => config.adminSubscriptionReadPerMin,
    ],
    [
      'subscription write',
      () => adminSubscriptionWriteRateLimits()[1],
      20,
      () => config.adminSubscriptionWritePerMin,
    ],
    [
      'administrative workflow trigger',
      () => adminWorkflowTriggerRateLimit(),
      10,
      () => config.adminWorkflowTriggerPerMin,
    ],
  ] as const)(
    'passes the unverified %s budget to the Postgres gate for a forged cookie',
    async (_family, gate, unverifiedLimit, verifiedLimit) => {
      expect(verifiedLimit()).not.toBe(unverifiedLimit)
      mockCheckAndIncrement.mockReset()
      pgAllows()
      const app = express()
      app.get('/gate', gate(), (_req, res) => res.sendStatus(204))
      await request(app).get('/gate').set('Cookie', 'control_ui_admin_session=forged-a').expect(204)
      await request(app)
        .get('/gate')
        .set('Cookie', 'control_ui_admin_session=signed-admin-a')
        .expect(204)

      expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
      const [forged, signed] = mockCheckAndIncrement.mock.calls
      expect(forged?.[0]).toMatch(/:ip:/)
      expect(forged?.[1]).toBe(unverifiedLimit)
      expect(signed?.[0]).not.toMatch(/:ip:/)
      expect(signed?.[1]).toBe(verifiedLimit())
    }
  )

  it('passes the anonymous IP budget to the Postgres gate for a forged attempt bearer', async () => {
    expect(config.llmProviderAttemptAuthorizePerMin).not.toBe(
      config.llmProviderAttemptAuthorizeAnonymousIpPerMin
    )
    mockCheckAndIncrement.mockReset()
    pgAllows()
    const app = express()
    app.post('/authorize', llmProviderAttemptAuthorizeRateLimits()[1], (_req, res) =>
      res.sendStatus(204)
    )
    const token = issueMcpHostAccessJwt('default', 'research-host', ['research-host'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    await request(app).post('/authorize').set('Authorization', 'Bearer forged-a').expect(204)
    await request(app).post('/authorize').set('Authorization', `Bearer ${token}`).expect(204)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    const [forged, verified] = mockCheckAndIncrement.mock.calls
    expect(forged?.[0]).toMatch(/^llm_provider_attempt:ip:/)
    expect(forged?.[1]).toBe(config.llmProviderAttemptAuthorizeAnonymousIpPerMin)
    expect(verified?.[0]).toBe('llm_provider_attempt:default/research-host')
    expect(verified?.[1]).toBe(config.llmProviderAttemptAuthorizePerMin)
  })

  it('denies the 31st forged subscription read through the edge and the Postgres gate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    countRequests()
    const app = express()
    app.get('/codex/connections', ...adminSubscriptionReadRateLimits(), (_req, res) =>
      res.sendStatus(204)
    )
    for (let i = 0; i < 30; i++) {
      await request(app)
        .get('/codex/connections')
        .set('Cookie', `control_ui_admin_session=forged-${i}`)
        .expect(204)
    }
    const denied = await request(app)
      .get('/codex/connections')
      .set('Cookie', 'control_ui_admin_session=forged-final')
      .expect(429)

    expect(denied.headers['retry-after']).toBeDefined()
    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(30)
    expect(mockCheckAndIncrement.mock.calls.every(call => call[1] === 30)).toBe(true)
  })

  beforeEach(() => {
    mockVerifyAdminToken.mockImplementation((token: string) =>
      token.startsWith('signed-') ? signedClaims(token.slice('signed-'.length)) : null
    )
    mockVerifyExternalSessionToken.mockImplementation((token: string) => {
      if (token === 'user-session-a' || token === 'user-session-a-rotated') {
        return { userId: 'user-a' }
      }
      if (token === 'user-session-b') {
        return { userId: 'user-b' }
      }
      return null
    })
  })

  it('adminWorkflowRateLimitCredential accepts HttpOnly admin session cookies', () => {
    const req = {
      header(name: string) {
        if (name.toLowerCase() === 'cookie') {
          return 'control_ui_admin_session=admin-cookie-token'
        }
        return undefined
      },
    } as express.Request

    expect(adminWorkflowRateLimitCredential(req)).toBe('admin-cookie-token')
  })

  it('llmProviderAttemptAuthorizeRateLimits meters callers before JWT is attached', async () => {
    mockCheckAndIncrement.mockReset()
    const app = express()
    app.post('/authorize', ...llmProviderAttemptAuthorizeRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    for (let i = 0; i < 60; i++) {
      pgAllows()
      await request(app).post('/authorize').expect(200)
    }
    pgAllows()
    const res = await request(app).post('/authorize').expect(429)
    expect(res.body).toMatchObject({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
  })

  it('mcpHostAttemptRateLimitKey aggregates rotating unverified bearers on the same IP', () => {
    const reqFor = (token: string) =>
      ({
        ip: '203.0.113.10',
        header: (name: string) =>
          name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
      }) as express.Request

    expect(mcpHostAttemptRateLimitKey(reqFor('forged-a'))).toBe(
      mcpHostAttemptRateLimitKey(reqFor('forged-b'))
    )
    expect(mcpHostAttemptRateLimitKey(reqFor('forged-a'))).toMatch(/^llm_provider_attempt:ip:/)
  })

  it('mcpHostAttemptRateLimitKey keys a missing bearer to the client IP', () => {
    const req = {
      ip: '203.0.113.10',
      header: () => undefined,
    } as express.Request

    expect(mcpHostAttemptRateLimitKey(req)).toMatch(/^llm_provider_attempt:ip:/)
  })

  it('mcpHostAttemptRateLimitKey applies the per-sub bucket only after the JWT verifies', () => {
    const tokenA = issueMcpHostAccessJwt('default', 'research-host', ['research-host'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const tokenARotated = issueMcpHostAccessJwt('default', 'research-host', ['research-host'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const tokenB = issueMcpHostAccessJwt('default', 'other-host', ['other-host'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const reqFor = (token: string) =>
      ({
        ip: '203.0.113.10',
        header: (name: string) =>
          name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
      }) as express.Request

    expect(mcpHostAttemptRateLimitKey(reqFor(tokenA))).toBe(
      'llm_provider_attempt:default/research-host'
    )
    expect(mcpHostAttemptRateLimitKey(reqFor(tokenARotated))).toBe(
      'llm_provider_attempt:default/research-host'
    )
    expect(mcpHostAttemptRateLimitKey(reqFor(tokenB))).toBe(
      'llm_provider_attempt:default/other-host'
    )
    expect(mcpHostAttemptRateLimitKey(reqFor(tokenA))).not.toBe(
      mcpHostAttemptRateLimitKey(reqFor('forged-not-a-jwt'))
    )
  })

  it('mcpHostAttemptRateLimitKey isolates standalone hosts that share the sentinel sub', () => {
    const tokenA = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['chatllm'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const tokenARotated = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['chatllm'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const tokenB = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['trader'], {
      workflowControlScopes: ['llm:codex:execute'],
    }).token
    const reqFor = (token: string) =>
      ({
        ip: '203.0.113.10',
        header: (name: string) =>
          name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
      }) as express.Request

    expect(mcpHostAttemptRateLimitKey(reqFor(tokenA))).toBe(
      `llm_provider_attempt:${config.hostsNamespace}/host/chatllm`
    )
    expect(mcpHostAttemptRateLimitKey(reqFor(tokenARotated))).toBe(
      `llm_provider_attempt:${config.hostsNamespace}/host/chatllm`
    )
    expect(mcpHostAttemptRateLimitKey(reqFor(tokenB))).toBe(
      `llm_provider_attempt:${config.hostsNamespace}/host/trader`
    )
    expect(mcpHostAttemptRateLimitKey(reqFor(tokenA))).not.toBe(
      mcpHostAttemptRateLimitKey(reqFor(tokenB))
    )
  })

  it('llmProviderAttemptAuthorizeRateLimits reuses one IP PG bucket for rotating unverified bearers', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 59,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/authorize', ...llmProviderAttemptAuthorizeRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app).post('/authorize').set('Authorization', 'Bearer forged-a').expect(200)
    await request(app).post('/authorize').set('Authorization', 'Bearer forged-b').expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^llm_provider_attempt:ip:/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('rate-limit factories pair an edge backstop with the PG limiter', () => {
    expect(workflowGrantReadRateLimits()).toHaveLength(2)
    expect(workflowGrantWriteRateLimits()).toHaveLength(2)
    expect(workflowAdminReadRateLimits()).toHaveLength(2)
    expect(adminOutputsReadRateLimits()).toHaveLength(2)
    expect(adminSubscriptionReadRateLimits()).toHaveLength(2)
    expect(adminSubscriptionWriteRateLimits()).toHaveLength(2)
    expect(llmProviderAttemptAuthorizeRateLimits()).toHaveLength(2)
    // The callback adds an edge-only per-IP ceiling ahead of the pair.
    expect(subscriptionOAuthCallbackRateLimits()).toHaveLength(3)
  })

  it('shouldSkipWorkflowGrantEdgeRateLimit skips anonymous callers', () => {
    const req = { header: () => undefined, ip: '203.0.113.10' } as express.Request
    expect(shouldSkipWorkflowGrantEdgeRateLimit(req)).toBe(true)
  })

  it('verifiedAdminRateLimitSubject ignores unverified cookies and bearers', () => {
    expect(verifiedAdminRateLimitSubject('forged-cookie')).toBeNull()
    expect(verifiedAdminRateLimitSubject('signed-admin-a')).toBe('admin-a')
  })

  it('workflowGrantEdgeRateLimitKey isolates verified admin subjects on the same IP', () => {
    const reqA = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-a' : undefined,
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-b' : undefined,
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).not.toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it('keeps rotated signed sessions in separate pre-auth buckets', () => {
    mockVerifyAdminToken.mockImplementation((value: string) =>
      value.startsWith('signed-') ? signedClaims('same-admin') : null
    )
    const reqA = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-a' : undefined,
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-b' : undefined,
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).not.toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it('workflowGrantEdgeRateLimitKey aggregates unverified cookies on the same IP', () => {
    const reqA = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=cookie-a' : undefined,
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=cookie-b' : undefined,
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it('workflowGrantEdgeRateLimitKey buckets distinct bogus bearer tokens from the same IP', () => {
    const reqA = {
      ip: '203.0.113.10',
      header: () => 'Bearer token-a',
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: () => 'Bearer token-b',
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it.each([
    {
      label: 'workflowGrantWriteRateLimits',
      method: 'put' as const,
      limit: 20,
      cookie: 'write-edge-cookie',
      mount: (app: express.Express) => {
        app.put('/probe', ...workflowGrantWriteRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
    {
      label: 'workflowGrantReadRateLimits',
      method: 'get' as const,
      limit: 60,
      cookie: 'grant-read-edge-cookie',
      mount: (app: express.Express) => {
        app.get('/probe', ...workflowGrantReadRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
    {
      label: 'workflowAdminReadRateLimits',
      method: 'get' as const,
      limit: 60,
      cookie: 'admin-read-edge-cookie',
      mount: (app: express.Express) => {
        app.get('/probe', ...workflowAdminReadRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
    {
      label: 'adminOutputsReadRateLimits',
      method: 'get' as const,
      limit: 30,
      cookie: 'outputs-read-edge-cookie',
      mount: (app: express.Express) => {
        app.get('/probe', ...adminOutputsReadRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
  ])(
    '$label returns 429 from the real edge factory after the quota',
    async ({ method, limit, cookie, mount }) => {
      mockCheckAndIncrement.mockReset()

      const app = express()
      mount(app)

      for (let i = 0; i < limit; i++) {
        pgAllows()
        await request(app)
          [method]('/probe')
          .set('Cookie', `control_ui_admin_session=${cookie}`)
          .expect(200)
      }

      pgAllows()
      const res = await request(app)
        [method]('/probe')
        .set('Cookie', `control_ui_admin_session=${cookie}`)
        .expect(429)

      expect(res.body).toMatchObject({
        error: 'Too Many Requests',
        retryAfterSeconds: expect.any(Number),
      })
      expect(res.headers['retry-after']).toBeDefined()
    }
  )

  it('workflowGrantWriteRateLimits does not edge-limit anonymous callers', async () => {
    mockCheckAndIncrement.mockReset()

    const app = express()
    app.put('/grants', ...workflowGrantWriteRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    for (let i = 0; i < 25; i++) {
      await request(app).put('/grants').expect(200)
    }
  })

  it('workflowGrantWriteRateLimits aggregates unverified cookie rotation on the same IP', async () => {
    mockCheckAndIncrement.mockReset()

    const app = express()
    app.put('/grants', ...workflowGrantWriteRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    for (let i = 0; i < 20; i++) {
      pgAllows()
      await request(app)
        .put('/grants')
        .set('Cookie', `control_ui_admin_session=forged-${i}`)
        .expect(200)
    }

    pgAllows()
    const res = await request(app)
      .put('/grants')
      .set('Cookie', 'control_ui_admin_session=forged-final')
      .expect(429)

    expect(res.body).toMatchObject({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
  })

  it('workflowGrantReadRateLimit reuses one IP PG bucket for rotated unverified cookies', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 59,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.get('/grants', workflowGrantReadRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .get('/grants')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-a')
      .expect(200)
    await request(app)
      .get('/grants')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_grants_read:ip:/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('workflowTriggerRateLimit reuses one IP PG bucket for rotated unverified cookies', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const { workflowTriggerRateLimit } = await import('../src/routes/workflows/shared/rateLimit.js')
    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('workflowTriggerRateLimit meters cookie-only admin workflow triggers', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const { workflowTriggerRateLimit } = await import('../src/routes/workflows/shared/rateLimit.js')
    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=signed-admin-cookie')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledOnce()
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
  })

  it('adminWorkflowTriggerRateLimit isolates rotated signed sessions', async () => {
    mockVerifyAdminToken.mockImplementation((value: string) =>
      value.startsWith('signed-') ? signedClaims('same-admin') : null
    )
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', adminWorkflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=signed-admin-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).not.toBe(
      mockCheckAndIncrement.mock.calls[1]?.[0]
    )
  })

  it('workflowGrantReadRateLimit meters cookie-only admin workflow callers', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 59,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.get('/grants', workflowGrantReadRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .get('/grants')
      .set('Cookie', 'control_ui_admin_session=signed-admin-cookie')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledOnce()
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_grants_read:[0-9a-f]{32}$/)
  })

  it('workflowTriggerRateLimitCredential prefers verified userId over service bearer', () => {
    const req = {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return 'Bearer service-token'
        if (name.toLowerCase() === 'x-user-session-token') return 'user-session-a'
        return undefined
      },
    } as express.Request

    expect(workflowTriggerRateLimitCredential(req)).toBe('user:user-a')
  })

  it('workflowTriggerRateLimitCredential reuses one userId across rotated session tokens', () => {
    const reqFor = (token: string) =>
      ({
        header(name: string) {
          if (name.toLowerCase() === 'authorization') return 'Bearer service-token'
          if (name.toLowerCase() === 'x-user-session-token') return token
          return undefined
        },
      }) as express.Request

    expect(workflowTriggerRateLimitCredential(reqFor('user-session-a'))).toBe('user:user-a')
    expect(workflowTriggerRateLimitCredential(reqFor('user-session-a-rotated'))).toBe('user:user-a')
  })

  it('workflowTriggerRateLimitCredential keys unverified user tokens to IP, not the bearer', () => {
    const req = {
      ip: '203.0.113.10',
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return 'Bearer service-token'
        if (name.toLowerCase() === 'x-user-session-token') return 'forged-session'
        return undefined
      },
    } as express.Request

    expect(workflowTriggerRateLimitCredential(req)).toMatch(/^ip:/)
    expect(workflowTriggerRateLimitCredential(req)).not.toBe('service-token')
  })

  it('workflowTriggerRateLimitCredential keys a real signed session and rejects a forged one', async () => {
    const actual = await vi.importActual<
      typeof import('../src/utils/auth/externalSessionAuthToken.js')
    >('../src/utils/auth/externalSessionAuthToken.js')
    mockVerifyExternalSessionToken.mockImplementation(token =>
      actual.verifyExternalSessionToken(token)
    )

    const signed = actual.signExternalSessionToken({
      userId: 'user-signed-1',
      email: 'signed@example.com',
      teamId: 'team-1',
      role: 'member',
      authGeneration: 1,
    })
    const reqFor = (token: string) =>
      ({
        ip: '203.0.113.10',
        header(name: string) {
          if (name.toLowerCase() === 'authorization') return 'Bearer service-token'
          if (name.toLowerCase() === 'x-user-session-token') return token
          return undefined
        },
      }) as express.Request

    expect(workflowTriggerRateLimitCredential(reqFor(signed))).toBe('user:user-signed-1')
    expect(workflowTriggerRateLimitCredential(reqFor('forged-not-a-jwt'))).toMatch(/^ip:/)
    expect(workflowTriggerRateLimitCredential(reqFor('forged-not-a-jwt'))).not.toBe('service-token')
  })

  it('workflowTriggerRateLimitCredential ignores whitespace user tokens and falls back to bearer', () => {
    const req = {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return 'Bearer service-token'
        if (name.toLowerCase() === 'x-user-session-token') return '   '
        return undefined
      },
    } as express.Request

    expect(workflowTriggerRateLimitCredential(req)).toBe('service-token')
  })

  it('workflowTriggerRateLimitCredential uses bearer when no user token is present', () => {
    const req = {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return 'Bearer service-token'
        return undefined
      },
    } as express.Request

    expect(workflowTriggerRateLimitCredential(req)).toBe('service-token')
  })

  it('mcpHostWorkflowTriggerRateLimitCredential ignores an injected user session header', () => {
    const req = {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return 'Bearer mcp-host-control-token'
        if (name.toLowerCase() === 'x-user-session-token') return 'user-session-a'
        return undefined
      },
    } as express.Request

    expect(mcpHostWorkflowTriggerRateLimitCredential(req)).toBe('mcp-host-control-token')
  })

  it('workflowTriggerRateLimit keys independent buckets for two users behind the same service bearer', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'user-session-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'user-session-b')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'user-session-a')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(3)
    const [keyA, keyB, keyAAgain] = mockCheckAndIncrement.mock.calls.map(call => call[0])
    expect(keyA).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(keyB).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(keyA).not.toBe(keyB)
    expect(keyAAgain).toBe(keyA)
  })

  it('workflowTriggerRateLimit reuses one bucket for two tokens of the same verified user', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'user-session-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'user-session-a-rotated')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('workflowTriggerRateLimit reuses one IP bucket for rotated unverified user tokens', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'forged-session-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer service-token')
      .set('x-user-session-token', 'forged-session-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('mcpHostWorkflowTriggerRateLimit stays on the bearer when a user session is injected', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', mcpHostWorkflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer mcp-host-control-token')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer mcp-host-control-token')
      .set('x-user-session-token', 'user-session-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Authorization', 'Bearer mcp-host-control-token')
      .set('x-user-session-token', 'forged-session')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(3)
    const [bearerOnly, injectedVerified, injectedForged] = mockCheckAndIncrement.mock.calls.map(
      call => call[0]
    )
    expect(bearerOnly).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(injectedVerified).toBe(bearerOnly)
    expect(injectedForged).toBe(bearerOnly)
  })

  it('workflowTriggerRateLimit falls back to the service bearer without a user token', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app).post('/trigger').set('Authorization', 'Bearer service-token').expect(200)
    await request(app).post('/trigger').set('Authorization', 'Bearer service-token').expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })
})
