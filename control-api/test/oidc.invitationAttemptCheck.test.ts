import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipKeyGenerator } from 'express-rate-limit'
import { DatabaseError } from 'pg'
import type { RateLimitCheck, RateLimitDecision } from '../src/middleware/rateLimitMiddleware.js'
import { rateLimitHitsTotal } from '../src/observability/metrics.js'
import {
  OIDC_INVITATION_HUB_DEADLINE_MS,
  OIDC_INVITATION_HUB_PER_CLIENT_PER_MINUTE,
  OIDC_INVITATION_TOKEN_RE,
  type OidcInvitationCheck,
  type OidcInvitationFallback,
  createOidcInvitationAttemptCheck,
} from '../src/services/auth/oidcInvitationAttemptCheck.js'
import type { InvitationRow } from '../src/services/directory/invitationStore.js'
import { validateInvitationFlowToken } from '../src/services/invitationFlowRegistrationService.js'
import {
  __resetMemberRegistrationEnrollmentForTests,
  ensureEnrollment,
} from '../src/services/memberRegistrationEnrollment.js'
import {
  MemberRegistrationMisconfiguredError,
  MemberRegistrationUnavailableError,
} from '../src/services/memberRegistrationErrors.js'

// Hosted mode against example.test names, so the real client resolves the
// destination through the real ensureEnrollment.
const { cfg } = vi.hoisted(() => ({
  cfg: {
    memberRegistrationMode: 'hosted',
    memberRegistrationExternalHubBaseUrl: 'https://hub.example.test/api/v1',
    desktopProfileUiBaseUrl: 'https://profile.example.test',
    controlUiBaseUrl: 'https://control.example.test',
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const credentials = vi.hoisted(() => ({
  getActiveMemberRegistrationCredential: vi.fn(),
  insertMemberRegistrationCredential: vi.fn(),
}))
vi.mock('../src/services/memberRegistrationCredentialsDb.js', () => credentials)

// The limiter's Postgres pool always fails here, so the default bucket counts
// in its process-memory fallback. No test reads the invitations table.
const database = vi.hoisted(() => ({
  query: vi.fn(),
  rateLimitQuery: vi.fn(),
}))
vi.mock('../src/db.js', () => ({
  pool: { query: database.query },
  rateLimitPool: { query: database.rateLimitQuery },
}))

/** Every call to any logger (root or child) as [level, bindings, ...args]. */
const logged = vi.hoisted(() => [] as unknown[][])
vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  const levels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  type Logger = typeof actual.rootLogger
  function recording(target: Logger, bindings: Record<string, unknown>): Logger {
    return new Proxy(target, {
      get(inner, prop, receiver) {
        if (prop === 'child') {
          return (childBindings: Record<string, unknown>) =>
            recording(inner.child(childBindings) as Logger, { ...bindings, ...childBindings })
        }
        if (typeof prop === 'string' && levels.has(prop)) {
          return (...args: unknown[]) => {
            logged.push([prop, bindings, ...args])
          }
        }
        return Reflect.get(inner, prop, receiver)
      },
    })
  }
  return { ...actual, rootLogger: recording(actual.rootLogger, {}) }
})

const TOKEN = 'fixture-invitation-flow-token.Zq8~'
const HUB_INVITATION_UUID = 'fixture-hub-invitation-uuid'
const INVITED_EMAIL = 'Invitee.Fixture@Example.test'
const IPV6_CLIENT = '2001:db8:1234:5678::1'
const OTHER_CLIENT = '203.0.113.9'
const HOST = 'profile.example.test'

const HUB_DEADLINE = { status: 'plain', fallback: 'hub_deadline' } as const

function plain(fallback: OidcInvitationFallback): OidcInvitationCheck {
  return { status: 'plain', fallback }
}

function input(clientIp = IPV6_CLIENT) {
  return { invitationToken: TOKEN, clientIp }
}

/** A row as getInvitationRecordByToken selects it: a pending member invitation. */
function pendingRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: '9b2f4c1e-5d6a-4e7b-8c9d-0a1b2c3d4e5f',
    team_id: '1c0d6b8a-2e4f-4a5b-9c7d-3e2f1a0b9c8d',
    invitee_name: 'Invitee Fixture',
    email: INVITED_EMAIL,
    role: 'member',
    token: HUB_INVITATION_UUID,
    status: 'pending',
    purpose: 'member_invitation',
    created_at: new Date(Date.now() - 60_000),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    accepted_at: null,
    accepted_user_id: null,
    team_name: 'Fixture team',
    ...overrides,
  }
}

const allowedDecision: RateLimitDecision = {
  outcome: 'allowed',
  limit: 30,
  remaining: 29,
  resetMs: Date.now() + 60_000,
}
const deniedDecision: RateLimitDecision = {
  outcome: 'denied',
  limit: 30,
  retryAfterSeconds: 30,
  resetMs: Date.now() + 60_000,
}
const unavailableDecision: RateLimitDecision = { outcome: 'unavailable', retryAfterSeconds: 5 }
const allowedLimiter: RateLimitCheck = async () => allowedDecision

function hubAccepts() {
  return vi.fn(async (_token: string, _signal: AbortSignal) => ({
    email: INVITED_EMAIL,
    invitationUuid: HUB_INVITATION_UUID,
  }))
}

/**
 * Stands in for global fetch. A request never settles on its own; it rejects
 * with an AbortError when its signal aborts, as real fetch does.
 */
function stubAbortAwareFetch(): Array<{ url: string; signal: AbortSignal }> {
  const calls: Array<{ url: string; signal: AbortSignal }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      calls.push({ url: String(url), signal })
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    })
  )
  return calls
}

function pathnames(calls: Array<{ url: string }>): string[] {
  return calls.map(call => new URL(call.url).pathname)
}

function loggedText(): string {
  return JSON.stringify(logged, (_key, value) =>
    value instanceof Error ? { ...value, name: value.name, message: value.message } : value
  )
}

function fellBackEvents(): unknown[][] {
  return logged
    .filter(entry => (entry[2] as { event?: unknown })?.event === 'oidc_invitation_check_fell_back')
    .map(entry => [entry[1], entry[2]])
}

/** Each fell_back event's level and fallback, in order. */
function fellBackLevels(): unknown[][] {
  return logged
    .filter(entry => (entry[2] as { event?: unknown })?.event === 'oidc_invitation_check_fell_back')
    .map(entry => [entry[0], (entry[2] as { fallback?: unknown }).fallback])
}

/** Each step_failed event with its level. */
function stepFailures(): unknown[][] {
  return logged
    .filter(
      entry => (entry[2] as { event?: unknown })?.event === 'oidc_invitation_check_step_failed'
    )
    .map(entry => [entry[0], entry[2]])
}

describe('the hub check for an OIDC attempt started from an invitation', () => {
  beforeEach(() => {
    __resetMemberRegistrationEnrollmentForTests()
    vi.useRealTimers()
    vi.clearAllMocks()
    logged.length = 0
    database.rateLimitQuery.mockRejectedValue(new Error('fixture: limiter backend unavailable'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pins the exported values', () => {
    expect(OIDC_INVITATION_HUB_DEADLINE_MS).toBe(3_000)
    expect(OIDC_INVITATION_HUB_PER_CLIENT_PER_MINUTE).toBe(30)
    expect(OIDC_INVITATION_TOKEN_RE.test('a'.repeat(2048))).toBe(true)
    expect(OIDC_INVITATION_TOKEN_RE.test('a'.repeat(2049))).toBe(false)
    expect(OIDC_INVITATION_TOKEN_RE.test('')).toBe(false)
    expect(OIDC_INVITATION_TOKEN_RE.test('with space')).toBe(false)
    expect(OIDC_INVITATION_TOKEN_RE.test('café')).toBe(false)
    expect(OIDC_INVITATION_TOKEN_RE.test(TOKEN)).toBe(true)
  })

  it('qualifies a pending member invitation with its id and lower-cased email', async () => {
    // The context's email is the local row's, so the hub answers with another.
    const validate = vi.fn(async (_token: string, _signal: AbortSignal) => ({
      email: 'hub-copy.fixture@example.test',
      invitationUuid: HUB_INVITATION_UUID,
    }))
    const readInvitation = vi.fn(async () => pendingRow())
    const check = createOidcInvitationAttemptCheck({
      limiter: allowedLimiter,
      validate,
      readInvitation,
    })

    expect(await check(input())).toStrictEqual({
      status: 'qualified',
      context: {
        invitationId: '9b2f4c1e-5d6a-4e7b-8c9d-0a1b2c3d4e5f',
        invitedEmail: 'invitee.fixture@example.test',
      },
    })
    expect(validate).toHaveBeenCalledOnce()
    expect(validate.mock.calls[0][0]).toBe(TOKEN)
    expect(validate.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    expect(readInvitation).toHaveBeenCalledWith(HUB_INVITATION_UUID)
    expect(fellBackEvents()).toEqual([])
  })

  it('clears its deadline once the check has answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const validate = hubAccepts()
    const check = createOidcInvitationAttemptCheck({
      limiter: allowedLimiter,
      validate,
      readInvitation: async () => pendingRow(),
    })

    expect((await check(input())).status).toBe('qualified')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(OIDC_INVITATION_HUB_DEADLINE_MS)
    expect(validate.mock.calls[0][1].aborted).toBe(false)
    expect(fellBackEvents()).toEqual([])
  })

  type Row = Readonly<{
    validateError?: Error
    row?: InvitationRow | null
    readError?: Error
    limiter?: RateLimitCheck
  }>
  const rows: Array<[string, Row, OidcInvitationFallback]> = [
    [
      'admin_desktop_access',
      { row: pendingRow({ purpose: 'admin_desktop_access' }) },
      'not_member_invitation',
    ],
    ['password_reset', { row: pendingRow({ purpose: 'password_reset' }) }, 'not_member_invitation'],
    [
      'accepted (with a password after the page load)',
      { row: pendingRow({ status: 'accepted', accepted_at: new Date() }) },
      'not_pending',
    ],
    ['revoked', { row: pendingRow({ status: 'revoked' }) }, 'not_pending'],
    ['draft', { row: pendingRow({ status: 'draft' }) }, 'not_pending'],
    ['expired', { row: pendingRow({ expires_at: new Date(Date.now() - 60_000) }) }, 'not_pending'],
    ['a missing row', { row: null }, 'not_pending'],
    [
      'a failed local read',
      { readError: new Error('fixture: connection terminated') },
      'not_pending',
    ],
    [
      'a hub 4xx',
      {
        validateError: new Error(
          'Member registration service POST /invitations-flow/validate failed (400): invalid_token'
        ),
      },
      'hub_refused',
    ],
    [
      'MemberRegistrationUnavailableError',
      { validateError: new MemberRegistrationUnavailableError('fixture: hub unreachable') },
      'hub_unavailable',
    ],
    [
      'MemberRegistrationMisconfiguredError',
      { validateError: new MemberRegistrationMisconfiguredError('fixture: not a real domain') },
      'hub_unavailable',
    ],
    [
      'a limiter that throws',
      {
        limiter: async () => {
          throw new Error('fixture: limiter bug')
        },
      },
      'over_limit',
    ],
  ]

  it.each(rows)('falls back to a plain attempt: %s', async (_name, row, fallback) => {
    const validate = vi.fn(async (_token: string, _signal: AbortSignal) => {
      if (row.validateError) throw row.validateError
      return { email: INVITED_EMAIL, invitationUuid: HUB_INVITATION_UUID }
    })
    const readInvitation = vi.fn(async () => {
      if (row.readError) throw row.readError
      return row.row === undefined ? pendingRow() : row.row
    })
    const check = createOidcInvitationAttemptCheck({
      limiter: row.limiter ?? allowedLimiter,
      validate,
      readInvitation,
    })

    expect(await check(input())).toStrictEqual(plain(fallback))
    // A refusal names the class of what the validate step threw.
    expect(fellBackEvents()).toEqual([
      [
        { component: 'oidc_profile_flow' },
        {
          event: 'oidc_invitation_check_fell_back',
          fallback,
          ...(fallback === 'hub_refused' ? { errorName: 'Error' } : {}),
        },
      ],
    ])
  })

  it('logs hub_deadline and hub_unavailable at warn, and every other fallback at info', async () => {
    // Rejects only once the deadline has answered, so the deadline decides.
    const answersOnlyOnAbort = (_token: string, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new MemberRegistrationUnavailableError('fixture: aborted')),
          { once: true }
        )
      })
    const cases: Array<
      [OidcInvitationFallback, Parameters<typeof createOidcInvitationAttemptCheck>[0]]
    > = [
      ['hub_deadline', { limiter: allowedLimiter, validate: answersOnlyOnAbort, deadlineMs: 5 }],
      [
        'hub_unavailable',
        {
          limiter: allowedLimiter,
          validate: async () => {
            throw new MemberRegistrationUnavailableError('fixture: hub unreachable')
          },
        },
      ],
      [
        'hub_refused',
        {
          limiter: allowedLimiter,
          validate: async () => {
            throw new Error(
              'Member registration service POST /invitations-flow/validate failed (400): invalid_token'
            )
          },
        },
      ],
      ['over_limit', { limiter: async () => deniedDecision, validate: hubAccepts() }],
      [
        'not_member_invitation',
        {
          limiter: allowedLimiter,
          validate: hubAccepts(),
          readInvitation: async () => pendingRow({ purpose: 'password_reset' }),
        },
      ],
      [
        'not_pending',
        { limiter: allowedLimiter, validate: hubAccepts(), readInvitation: async () => null },
      ],
    ]

    for (const [fallback, deps] of cases) {
      expect(await createOidcInvitationAttemptCheck(deps)(input())).toStrictEqual(plain(fallback))
    }

    expect(fellBackLevels()).toEqual([
      ['warn', 'hub_deadline'],
      ['warn', 'hub_unavailable'],
      ['info', 'hub_refused'],
      ['info', 'over_limit'],
      ['info', 'not_member_invitation'],
      ['info', 'not_pending'],
    ])
  })

  it('logs a limiter throw as a failed bucket step, by its class, and calls no hub', async () => {
    const validate = hubAccepts()
    const check = createOidcInvitationAttemptCheck({
      limiter: async () => {
        throw new TypeError('fixture: limiter bug')
      },
      validate,
      readInvitation: async () => pendingRow(),
    })

    expect(await check(input())).toStrictEqual(plain('over_limit'))
    expect(validate).not.toHaveBeenCalled()
    expect(stepFailures()).toEqual([
      [
        'error',
        { event: 'oidc_invitation_check_step_failed', step: 'bucket', errorName: 'TypeError' },
      ],
    ])
    expect(fellBackLevels()).toEqual([['info', 'over_limit']])
  })

  it('names an unexpected validate throw by its class in the hub_refused fallback', async () => {
    const check = createOidcInvitationAttemptCheck({
      limiter: allowedLimiter,
      validate: async () => {
        throw new TypeError(`Cannot read properties of undefined (reading '${INVITED_EMAIL}')`)
      },
      readInvitation: async () => pendingRow(),
    })

    expect(await check(input())).toStrictEqual(plain('hub_refused'))
    expect(fellBackEvents()).toEqual([
      [
        { component: 'oidc_profile_flow' },
        {
          event: 'oidc_invitation_check_fell_back',
          fallback: 'hub_refused',
          errorName: 'TypeError',
        },
      ],
    ])
    // The class only: never the message, which here holds the email.
    expect(loggedText().toLowerCase()).not.toContain(INVITED_EMAIL.toLowerCase())
  })

  it('names a failed local read by its class, not by the name pg gives it', async () => {
    // pg's answer to a read Postgres cancelled: the class, message, length,
    // code and server fields are copied from a live run (statement_timeout).
    const failure = Object.assign(
      new DatabaseError('canceling statement due to statement timeout', 109, 'error'),
      {
        severity: 'ERROR',
        code: '57014',
        file: 'postgres.c',
        line: '3394',
        routine: 'ProcessInterrupts',
      }
    )
    expect(failure.name).toBe('error')
    const check = createOidcInvitationAttemptCheck({
      limiter: allowedLimiter,
      validate: hubAccepts(),
      readInvitation: async () => {
        throw failure
      },
    })

    expect(await check(input())).toStrictEqual(plain('not_pending'))
    expect(stepFailures()).toEqual([
      [
        'error',
        {
          event: 'oidc_invitation_check_step_failed',
          step: 'local_read',
          errorName: 'DatabaseError',
        },
      ],
    ])
  })

  it('answers at 3 s in hosted mode while enrollment never answers, and leaves no negative-cache entry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    credentials.getActiveMemberRegistrationCredential.mockResolvedValue(null)
    const calls = stubAbortAwareFetch()
    const check = createOidcInvitationAttemptCheck({ limiter: allowedLimiter })

    let settled: OidcInvitationCheck | undefined
    void check(input()).then(result => {
      settled = result
    })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toStrictEqual(HUB_DEADLINE)

    // One request, the enrollment mint, still running: the deadline never
    // reached it. No validate request went out.
    expect(pathnames(calls)).toEqual(['/public/tenants'])
    expect(calls[0].signal.aborted).toBe(false)

    // The mint is still shared and pending, so no backoff was written.
    let enrollment: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    void ensureEnrollment(HOST).then(
      () => {
        enrollment = 'fulfilled'
      },
      () => {
        enrollment = 'rejected'
      }
    )
    // Positive control: the same flush does observe an enrollment rejection.
    let control: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    void ensureEnrollment('localhost').then(
      () => {
        control = 'fulfilled'
      },
      () => {
        control = 'rejected'
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(control).toBe('rejected')
    expect(enrollment).toBe('pending')
    expect(pathnames(calls)).toEqual(['/public/tenants'])
  })

  it('aborts the validate request at 3 s when a credential is stored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    credentials.getActiveMemberRegistrationCredential.mockResolvedValue({
      boundDomain: HOST,
      tenantId: 'fixture-tenant',
      kid: 'fixture-kid',
      secret: 'fixture-hub-secret',
    })
    const calls = stubAbortAwareFetch()
    const check = createOidcInvitationAttemptCheck({ limiter: allowedLimiter })

    let settled: OidcInvitationCheck | undefined
    void check(input()).then(result => {
      settled = result
    })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBeUndefined()
    expect(pathnames(calls)).toEqual(['/api/v1/invitations-flow/validate'])
    expect(calls[0].signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    // The closed socket: the validate request's own signal aborted.
    expect(calls[0].signal.aborted).toBe(true)
    expect(settled).toStrictEqual(HUB_DEADLINE)
  })

  it('keeps the 20 s bound alone on the validate request of a caller that passes no signal', async () => {
    credentials.getActiveMemberRegistrationCredential.mockResolvedValue({
      boundDomain: HOST,
      tenantId: 'fixture-tenant',
      kid: 'fixture-kid',
      secret: 'fixture-hub-secret',
    })
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const calls = stubAbortAwareFetch()
    try {
      // The request never settles here. Its own 20 s timeout rejects it after
      // this test, which only reads the signal it was sent with.
      validateInvitationFlowToken(TOKEN).catch(() => undefined)
      await vi.waitFor(() => expect(calls).toHaveLength(1))

      expect(pathnames(calls)).toEqual(['/api/v1/invitations-flow/validate'])
      expect(timeoutSpy).toHaveBeenCalledOnce()
      expect(timeoutSpy).toHaveBeenCalledWith(20_000)
      expect(calls[0].signal).toBe(timeoutSpy.mock.results[0].value)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('treats a denied bucket decision as over_limit without calling the hub, keyed by client IP', async () => {
    const keys: string[] = []
    const deadlines: unknown[] = []
    let counted = 0
    let backend: 'counting' | 'unavailable' = 'counting'
    const limiter: RateLimitCheck = vi.fn(async (key: string, _log, deadline) => {
      keys.push(key)
      deadlines.push(deadline)
      if (backend === 'unavailable') return unavailableDecision
      counted += 1
      return counted <= 30 ? allowedDecision : deniedDecision
    })
    const validate = hubAccepts()
    const check = createOidcInvitationAttemptCheck({
      limiter,
      validate,
      readInvitation: async () => pendingRow(),
    })

    for (let i = 0; i < 30; i += 1) {
      expect((await check(input())).status).toBe('qualified')
    }
    expect(await check(input())).toStrictEqual(plain('over_limit'))
    expect(validate).toHaveBeenCalledTimes(30)

    backend = 'unavailable'
    expect(await check(input())).toStrictEqual(plain('over_limit'))
    expect(validate).toHaveBeenCalledTimes(30)

    // An IPv6 client is keyed by its /56, as ipKeyGenerator masks it.
    const ipv6Key = `oidc-invitation-hub:${ipKeyGenerator(IPV6_CLIENT)}`
    expect(ipv6Key).toBe('oidc-invitation-hub:2001:db8:1234:5600::/56')
    expect(keys).toEqual(Array.from({ length: 32 }, () => ipv6Key))

    // Positive control: another client gets its own key.
    backend = 'counting'
    counted = 0
    expect((await check(input(OTHER_CLIENT))).status).toBe('qualified')
    expect(keys.at(-1)).toBe(`oidc-invitation-hub:${OTHER_CLIENT}`)

    // Every count ran under the check's deadline signal, which never fired.
    expect(deadlines).toHaveLength(33)
    for (const deadline of deadlines) {
      expect(deadline).toBeInstanceOf(AbortSignal)
      expect((deadline as AbortSignal).aborted).toBe(false)
    }
  })

  it('counts 30 checks a minute per client IP in its default bucket, in process memory when Postgres cannot count', async () => {
    const validate = hubAccepts()
    const check = createOidcInvitationAttemptCheck({
      validate,
      readInvitation: async () => pendingRow(),
    })

    for (let i = 0; i < 30; i += 1) {
      expect((await check(input())).status).toBe('qualified')
    }
    expect(await check(input())).toStrictEqual(plain('over_limit'))
    expect(validate).toHaveBeenCalledTimes(30)
    expect((await check(input(OTHER_CLIENT))).status).toBe('qualified')
    expect(database.rateLimitQuery).toHaveBeenCalled()

    const hits = (await rateLimitHitsTotal.get()).values.filter(
      value => value.labels.bucket_type === 'oidc_invitation_hub_check'
    )
    expect(Object.fromEntries(hits.map(value => [value.labels.result, value.value]))).toEqual({
      fallback_allowed: 31,
      fallback_denied: 1,
    })
  })

  it('starts no hub call and no local read once the deadline has answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const lateAllowed: RateLimitCheck = vi.fn(
      () =>
        new Promise<RateLimitDecision>(resolve => setTimeout(() => resolve(allowedDecision), 3_500))
    )
    const validate = hubAccepts()
    const readInvitation = vi.fn(async () => pendingRow())
    let settled: OidcInvitationCheck | undefined
    void createOidcInvitationAttemptCheck({ limiter: lateAllowed, validate, readInvitation })(
      input()
    ).then(result => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(settled).toStrictEqual(HUB_DEADLINE)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lateAllowed).toHaveBeenCalledOnce()
    expect(validate).not.toHaveBeenCalled()

    const lateHub = vi.fn(
      (_token: string, _signal: AbortSignal) =>
        new Promise<{ email: string; invitationUuid: string }>(resolve =>
          setTimeout(
            () => resolve({ email: INVITED_EMAIL, invitationUuid: HUB_INVITATION_UUID }),
            3_500
          )
        )
    )
    settled = undefined
    void createOidcInvitationAttemptCheck({
      limiter: allowedLimiter,
      validate: lateHub,
      readInvitation,
    })(input()).then(result => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(settled).toStrictEqual(HUB_DEADLINE)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lateHub).toHaveBeenCalledOnce()
    expect(readInvitation).not.toHaveBeenCalled()
  })

  it('does not surface a late hub failure as an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let rejected = false
      const validate = vi.fn(
        (_token: string, _signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              rejected = true
              reject(new MemberRegistrationUnavailableError('fixture: late hub failure'))
            }, 3_500)
          })
      )
      const check = createOidcInvitationAttemptCheck({ limiter: allowedLimiter, validate })

      let settled: OidcInvitationCheck | undefined
      void check(input()).then(result => {
        settled = result
      })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(settled).toStrictEqual(HUB_DEADLINE)
      expect(rejected).toBe(false)

      await vi.advanceTimersByTimeAsync(600)
      expect(rejected).toBe(true)
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      expect(settled).toStrictEqual(HUB_DEADLINE)
      expect(fellBackEvents()).toEqual([
        [
          { component: 'oidc_profile_flow' },
          { event: 'oidc_invitation_check_fell_back', fallback: 'hub_deadline' },
        ],
      ])
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('never logs the token or the email', async () => {
    const echoing = `${TOKEN} was sent to ${INVITED_EMAIL}`
    const validate = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          `Member registration service POST /invitations-flow/validate failed (400): ${echoing}`
        )
      )
      .mockResolvedValue({ email: INVITED_EMAIL, invitationUuid: HUB_INVITATION_UUID })
    const readInvitation = vi
      .fn()
      .mockResolvedValueOnce(pendingRow({ status: 'accepted' }))
      .mockRejectedValueOnce(new Error(`fixture: read failed for ${echoing}`))
    const check = createOidcInvitationAttemptCheck({
      limiter: allowedLimiter,
      validate,
      readInvitation,
    })

    expect(await check(input())).toStrictEqual(plain('hub_refused'))
    expect(await check(input())).toStrictEqual(plain('not_pending'))
    expect(await check(input())).toStrictEqual(plain('not_pending'))

    expect(fellBackEvents()).toEqual([
      [
        { component: 'oidc_profile_flow' },
        { event: 'oidc_invitation_check_fell_back', fallback: 'hub_refused', errorName: 'Error' },
      ],
      [
        { component: 'oidc_profile_flow' },
        { event: 'oidc_invitation_check_fell_back', fallback: 'not_pending' },
      ],
      [
        { component: 'oidc_profile_flow' },
        { event: 'oidc_invitation_check_fell_back', fallback: 'not_pending' },
      ],
    ])
    // The failed read is visible by its error name only.
    expect(
      logged
        .filter(
          entry => (entry[2] as { event?: unknown })?.event === 'oidc_invitation_check_step_failed'
        )
        .map(entry => entry[2])
    ).toEqual([
      { event: 'oidc_invitation_check_step_failed', step: 'local_read', errorName: 'Error' },
    ])

    const text = loggedText()
    expect(text).not.toContain(TOKEN)
    expect(text.toLowerCase()).not.toContain(INVITED_EMAIL.toLowerCase())
  })
})
