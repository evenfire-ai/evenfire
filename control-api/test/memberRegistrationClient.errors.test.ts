import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAndSendInvitation } from '../src/services/invitationFlowRegistrationService.js'
import { MemberRegistrationUnavailableError } from '../src/services/memberRegistrationErrors.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    memberRegistrationMode: 'remote',
    memberRegistrationExternalHubBaseUrl: 'https://registration.evenfire.ai/api/v1',
    memberRegistrationServiceBaseUrl: 'http://member-registration-service.local:8092/api/v1',
    memberRegistrationServiceHmacSecret: 'env-secret',
    memberRegistrationServiceHmacKid: 'env-kid',
    memberRegistrationTenantId: 'clerum-dev',
    desktopProfileUiBaseUrl: 'https://profile.acme.com',
    controlUiBaseUrl: 'https://control.acme.com',
    desktopExternalRestApiBaseUrl: 'http://127.0.0.1:8091',
    desktopRpcProxyBaseUrl: 'http://127.0.0.1:8094',
    desktopAppName: 'Evenfire',
    controlUiAppName: 'Evenfire',
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const enrollment = vi.hoisted(() => ({
  ensureEnrollment: vi.fn(),
  normalizeEnrollmentHost: (baseUrl: string) => new URL(baseUrl).hostname.toLowerCase(),
}))
vi.mock('../src/services/memberRegistrationEnrollment.js', () => enrollment)

function send(): Promise<void> {
  return registerAndSendInvitation('a@b.c', 'uuid-1', 'team', '2026-01-01', '2026-02-01')
}

async function caught(): Promise<Error> {
  return send().then(
    () => {
      throw new Error('expected send() to reject')
    },
    (error: unknown) => error as Error
  )
}

describe('member-registration client failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    cfg.memberRegistrationMode = 'remote'
  })

  it('fetch rejecting (minikube: no registration namespace) becomes Unavailable, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(send()).rejects.toBeInstanceOf(MemberRegistrationUnavailableError)
  })

  it('a timeout/abort becomes Unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted due to timeout', 'TimeoutError'))
    )
    await expect(send()).rejects.toBeInstanceOf(MemberRegistrationUnavailableError)
  })

  it('passes an AbortSignal so a stalled hub cannot hang the request forever', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"sent":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await send()
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a non-JSON 2xx body becomes Unavailable, not a raw SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      )
    )
    await expect(send()).rejects.toBeInstanceOf(MemberRegistrationUnavailableError)
  })

  it('an upstream 5xx becomes Unavailable and never leaks the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"SECRET_BODY"}', { status: 500 }))
    )
    const error = await caught()
    expect(error).toBeInstanceOf(MemberRegistrationUnavailableError)
    expect(error.message).not.toContain('SECRET_BODY')
    expect(error.message).toContain('500')
  })

  it('REGRESSION: an upstream 404 keeps the legacy plain Error and message so routes still match (spec §4.1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"nope"}', { status: 404 }))
    )
    const error = await caught()
    expect(error).not.toBeInstanceOf(MemberRegistrationUnavailableError)
    expect(error.message).toContain('Member registration service')
    expect(error.message).toContain('(404)')
  })

  it('REGRESSION: an upstream 403 keeps the legacy plain Error (teams routes sniff this message)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }))
    )
    const error = await caught()
    expect(error).not.toBeInstanceOf(MemberRegistrationUnavailableError)
    expect(error.message).toContain('Member registration service')
    expect(error.message).toContain('(403)')
  })

  it('a body read failure (stalled body / mid-body reset) becomes Unavailable, not a raw AbortError', async () => {
    const response = new Response('{"ok":true}', { status: 200 })
    vi.spyOn(response, 'text').mockRejectedValue(
      new DOMException('The user aborted a request.', 'AbortError')
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(send()).rejects.toBeInstanceOf(MemberRegistrationUnavailableError)
  })

  it('REGRESSION: a non-JSON 404 keeps the legacy plain Error but does not leak the raw body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html><body>upstream-internal-host.local error</body></html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        })
      )
    )
    const error = await caught()
    expect(error).not.toBeInstanceOf(MemberRegistrationUnavailableError)
    expect(error.message).toContain('Member registration service')
    expect(error.message).toContain('(404)')
    expect(error.message).not.toContain('upstream-internal-host.local')
  })
})
