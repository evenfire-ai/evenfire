import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetMemberRegistrationEnrollmentForTests,
  ensureEnrollment,
  normalizeEnrollmentHost,
  runBootEnrollment,
} from '../src/services/memberRegistrationEnrollment.js'
import {
  MemberRegistrationMisconfiguredError,
  MemberRegistrationUnavailableError,
} from '../src/services/memberRegistrationErrors.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    memberRegistrationMode: 'hosted',
    memberRegistrationExternalHubBaseUrl: 'https://registration.evenfire.ai/api/v1',
    desktopProfileUiBaseUrl: 'https://profile.acme.com',
    controlUiBaseUrl: 'https://control.acme.com',
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const store = vi.hoisted(() => ({
  getActiveMemberRegistrationCredential: vi.fn(),
  insertMemberRegistrationCredential: vi.fn(),
}))
vi.mock('../src/services/memberRegistrationCredentialsDb.js', () => store)

const logSink = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: {
    info: (...args: unknown[]) => logSink.lines.push(JSON.stringify(args)),
    warn: (...args: unknown[]) => logSink.lines.push(JSON.stringify(args)),
    error: (...args: unknown[]) => logSink.lines.push(JSON.stringify(args)),
  },
}))

const CRED = {
  boundDomain: 'profile.acme.com',
  tenantId: 'ext-abc123',
  kid: 'ext-abc123-deadbeef',
  secret: 'hub-secret',
}

function mintResponse(): Response {
  return new Response(
    JSON.stringify({ tenantId: CRED.tenantId, kid: CRED.kid, secret: CRED.secret }),
    { status: 201, headers: { 'content-type': 'application/json' } }
  )
}

describe('memberRegistrationEnrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    logSink.lines.length = 0
    __resetMemberRegistrationEnrollmentForTests()
    cfg.memberRegistrationMode = 'hosted'
    cfg.desktopProfileUiBaseUrl = 'https://profile.acme.com'
    cfg.controlUiBaseUrl = 'https://control.acme.com'
    store.getActiveMemberRegistrationCredential.mockResolvedValue(null)
    store.insertMemberRegistrationCredential.mockResolvedValue({ inserted: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('normalizeEnrollmentHost lowercases and strips port/scheme/path', () => {
    expect(normalizeEnrollmentHost('https://Profile.ACME.com:8443/x/y')).toBe('profile.acme.com')
  })

  it('mints against the hub ORIGIN (not /api/v1) with a 10s bounded timeout, persists, returns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse())
    vi.stubGlobal('fetch', fetchMock)
    // Observe the BOUND, not merely "some signal": toBeInstanceOf(AbortSignal)
    // is satisfied by a never-firing controller signal or a 999s timeout.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    store.getActiveMemberRegistrationCredential
      .mockResolvedValueOnce(null) // pre-mint check
      .mockResolvedValueOnce(CRED) // adopt-winner re-select
    const cred = await ensureEnrollment('profile.acme.com')
    expect(cred).toEqual(CRED)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://registration.evenfire.ai/public/tenants')
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    expect(init.signal).toBe(timeoutSpy.mock.results[0].value)
    expect(JSON.parse(init.body)).toEqual({ domain: 'profile.acme.com' })
    expect(store.insertMemberRegistrationCredential).toHaveBeenCalledWith({
      boundDomain: 'profile.acme.com',
      tenantId: CRED.tenantId,
      kid: CRED.kid,
      secret: CRED.secret,
    })
  })

  it('reuses a stored credential without minting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    store.getActiveMemberRegistrationCredential.mockResolvedValue(CRED)
    expect(await ensureEnrollment('profile.acme.com')).toEqual(CRED)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('collapses concurrent calls into one mint (in-flight map)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse())
    vi.stubGlobal('fetch', fetchMock)
    // STATEFUL store: a `mockResolvedValueOnce(null).mockResolvedValue(CRED)`
    // sequence would let caller 2's PRE-MINT select consume the persisted CRED
    // and skip minting, so the test would pass with the in-flight map deleted.
    // Here both callers see null until an insert happens — only the map can
    // hold fetch at 1.
    let stored: typeof CRED | null = null
    store.getActiveMemberRegistrationCredential.mockImplementation(async () => stored)
    store.insertMemberRegistrationCredential.mockImplementation(async () => {
      stored = CRED
      return { inserted: true }
    })
    const [a, b] = await Promise.all([
      ensureEnrollment('profile.acme.com'),
      ensureEnrollment('profile.acme.com'),
    ])
    expect(a).toEqual(CRED)
    expect(b).toEqual(CRED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('adopts the winner on a lost insert race and logs the orphan WITHOUT the secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse())
    vi.stubGlobal('fetch', fetchMock)
    store.insertMemberRegistrationCredential.mockResolvedValue({ inserted: false })
    store.getActiveMemberRegistrationCredential
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...CRED, kid: 'ext-winner-kid', secret: 'winner-secret' })
    const cred = await ensureEnrollment('profile.acme.com')
    expect(cred.kid).toBe('ext-winner-kid')
    expect(logSink.lines.join('\n')).toContain('orphan')
    expect(logSink.lines.join('\n')).not.toContain('hub-secret')
    expect(logSink.lines.join('\n')).not.toContain('winner-secret')
  })

  it('negative-caches a hub 4xx for the FULL 10min TTL, not the transient backoff window', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'domain_blocked' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1) // second call served from the negative cache

    // Intermediate sample PAST the transient backoff cap (5min) but INSIDE the
    // 4xx TTL (10min): pins TTL(4xx) > backoff-cap, so routing 4xx through the
    // transient path (an easy collapse — both write negativeCache) fails here.
    vi.advanceTimersByTime(5 * 60 * 1000)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60 * 1000 + 1) // now past the 10min TTL
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2) // TTL expired → one fresh attempt
  })

  it('backs off exponentially on network errors and recovers after the window', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    // within the 5s backoff window: cached, no new fetch
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000 + 1)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a hub 5xx as transient (5s backoff), NOT as a terminal 4xx rejection', async () => {
    // Without this, the 5xx branch is dead code: an implementation that treats
    // every !response.ok as terminal blanks invitations for 10min on a hub 502.
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000 + 1) // transient window, well inside the 4xx TTL
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('escalates the backoff on repeated malformed 2xx mint bodies instead of resetting to the 5s base every time', async () => {
    // If the failure counter is cleared as soon as response.ok is true (before
    // the body-shape check), a hub that keeps returning 2xx with a malformed
    // body will re-mint at the 5s base forever — transientFailure() bumps the
    // counter back to 1 every attempt, so BACKOFF_BASE_MS * 2**(1-1) never
    // escalates. The network-error/5xx paths don't have this bug because they
    // never touch the counter before calling transientFailure().
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000 + 1) // past the 5s base backoff (failures=1)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(5_000 + 1) // still inside the escalated 10s window (failures=2)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2) // served from cache — no re-mint yet

    vi.advanceTimersByTime(5_000 + 1) // now past the escalated 10s window
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('negative-caches a 200 response with an unparseable body (proxy/WAF page) instead of re-minting every request', async () => {
    // response.json() throws SyntaxError on a non-JSON 200 body. Before the
    // fix this escaped enroll() untyped and unguarded — no negative-cache
    // entry, so every subsequent request re-minted (the exact amplifier the
    // cache exists to prevent).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>proxy error</html>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Second immediate call must be served from the negative cache, not re-fetch.
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Log hygiene: the parse error must never echo the raw body.
    expect(logSink.lines.join('\n')).not.toContain('<html>')
    expect(logSink.lines.join('\n')).not.toContain('proxy error')
  })

  it('negative-caches a persistence failure after a successful mint instead of re-minting a fresh hub credential every request', async () => {
    // insertMemberRegistrationCredential throwing (e.g. Postgres unreachable)
    // after a successful mint was unguarded before the fix — every subsequent
    // request would mint a brand-new hub credential (an orphan mint storm).
    const fetchMock = vi.fn().mockResolvedValue(mintResponse())
    vi.stubGlobal('fetch', fetchMock)
    store.insertMemberRegistrationCredential.mockRejectedValue(new Error('pg down'))
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Second immediate call must be served from the negative cache, not re-mint.
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('escalates the backoff on repeated persist failures during a sustained Postgres outage', async () => {
    // Mirrors 'escalates the backoff on repeated malformed 2xx mint bodies':
    // a single 5s-window sample isn't enough to prove escalation, because a
    // counter that gets reset on every attempt (bug: deleting the counter
    // right after the mint body validates, before the persist block) also
    // produces a 5s backoff on the FIRST retry — it only diverges from the
    // correct behavior on the SECOND retry, which must wait 10s, not 5s.
    const fetchMock = vi.fn().mockImplementation(async () => mintResponse())
    vi.stubGlobal('fetch', fetchMock)
    store.insertMemberRegistrationCredential.mockRejectedValue(new Error('pg down'))

    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000 + 1) // past the 5s base backoff (failures=1)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(5_000 + 1) // still inside the escalated 10s window (failures=2)
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    // Fails against the unfixed code: the counter is deleted before the
    // persist block, so every failure computes failures=1 and re-mints every
    // 5s instead of escalating — this call would observe fetchMock called 3
    // times instead of still being served from the negative cache.
    expect(fetchMock).toHaveBeenCalledTimes(2) // served from cache — no re-mint yet

    vi.advanceTimersByTime(5_000 + 1) // now past the escalated 10s window
    await expect(ensureEnrollment('profile.acme.com')).rejects.toBeInstanceOf(
      MemberRegistrationUnavailableError
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects localhost / IP-literal / dotless hosts with the misconfiguration error, never fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'minikube']) {
      await expect(ensureEnrollment(host)).rejects.toBeInstanceOf(
        MemberRegistrationMisconfiguredError
      )
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runBootEnrollment enrolls each unique host and NEVER rejects on failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(runBootEnrollment()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2) // profile.acme.com + control.acme.com
    expect(logSink.lines.join('\n')).toContain('member_registration_boot_enrollment_failed')
  })

  it('runBootEnrollment swallows UNTYPED failures too (the catch is unconditional)', async () => {
    // The fetch-rejection case above only proves typed errors are caught —
    // enroll() wraps them. A hook whose catch is narrowed to the typed error
    // ("rethrow unexpected errors for visibility") would still pass that one,
    // then crash-loop boot when Postgres is briefly unreachable at startup.
    vi.stubGlobal('fetch', vi.fn())
    store.getActiveMemberRegistrationCredential.mockRejectedValue(new Error('db down'))
    await expect(runBootEnrollment()).resolves.toBeUndefined()
    expect(logSink.lines.join('\n')).toContain('member_registration_boot_enrollment_failed')
  })

  it('runBootEnrollment dedupes hosts sharing a hostname and no-ops in remote mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse())
    vi.stubGlobal('fetch', fetchMock)
    store.getActiveMemberRegistrationCredential.mockResolvedValueOnce(null).mockResolvedValue(CRED)
    cfg.desktopProfileUiBaseUrl = 'https://apps.acme.com:3001'
    cfg.controlUiBaseUrl = 'https://apps.acme.com:3000'
    await runBootEnrollment()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    // Assert at the STORE boundary: with a stored credential lingering from the
    // hosted half, a dropped mode gate would still show fetch=0 while running
    // enrollment DB reads on every remote (incl. managed/MCC) boot.
    store.getActiveMemberRegistrationCredential.mockClear()
    cfg.memberRegistrationMode = 'remote'
    await runBootEnrollment()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.getActiveMemberRegistrationCredential).not.toHaveBeenCalled()
  })
})
