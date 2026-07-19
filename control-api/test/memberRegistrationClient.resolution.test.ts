import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import {
  registerAndSendControlAdminInvitation,
  validateControlAdminInvitationToken,
} from '../src/services/controlAdminInvitationRegistrationService.js'
import {
  registerAndSendInvitation,
  validateInvitationFlowToken,
} from '../src/services/invitationFlowRegistrationService.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    memberRegistrationMode: 'hosted',
    memberRegistrationExternalHubBaseUrl: 'https://registration.evenfire.ai/api/v1',
    memberRegistrationServiceBaseUrl: '',
    memberRegistrationServiceHmacSecret: '',
    memberRegistrationServiceHmacKid: 'example-dev',
    memberRegistrationTenantId: 'example-dev',
    desktopProfileUiBaseUrl: 'https://profile.acme.com',
    controlUiBaseUrl: 'https://control.acme.com',
    desktopExternalRestApiBaseUrl: 'http://127.0.0.1:8091',
    desktopRpcProxyBaseUrl: 'http://127.0.0.1:8094',
    desktopAppName: 'Evenfire',
    controlUiAppName: 'Evenfire',
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

// Per-domain credentials so a transposed wrapper→host mapping is DETECTABLE
// (spec §8.8 directional assertion).
const CREDS: Record<
  string,
  { boundDomain: string; tenantId: string; kid: string; secret: string }
> = {
  'profile.acme.com': {
    boundDomain: 'profile.acme.com',
    tenantId: 'ext-profile',
    kid: 'kid-profile',
    secret: 'secret-profile',
  },
  'control.acme.com': {
    boundDomain: 'control.acme.com',
    tenantId: 'ext-control',
    kid: 'kid-control',
    secret: 'secret-control',
  },
}
const enrollment = vi.hoisted(() => ({
  ensureEnrollment: vi.fn(),
  normalizeEnrollmentHost: (baseUrl: string) => new URL(baseUrl).hostname.toLowerCase(),
}))
vi.mock('../src/services/memberRegistrationEnrollment.js', () => enrollment)

function decodeAuthKid(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const [, init] = fetchMock.mock.calls[callIndex]
  const token = String(init.headers.authorization).replace(/^Bearer /, '')
  const [h, p, sig] = token.split('.')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString())
  return { header, signingInput: `${h}.${p}`, sig }
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('member-registration client per-host resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    cfg.memberRegistrationMode = 'hosted'
    enrollment.ensureEnrollment.mockImplementation(async (domain: string) => {
      const cred = CREDS[domain]
      if (!cred) throw new Error(`unexpected domain ${domain}`)
      return cred
    })
  })

  it('member SEND and VALIDATE sign with the profile-ui host credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ sent: true, registered: true }))
      .mockResolvedValueOnce(okJson({ valid: true, email: 'a@b.c', invitationUuid: 'u' }))
    vi.stubGlobal('fetch', fetchMock)

    await registerAndSendInvitation('a@b.c', 'uuid-1', 'team', '2026-01-01', '2026-02-01')
    await validateInvitationFlowToken('tok', 'a@b.c')

    for (const i of [0, 1]) {
      const { header, signingInput, sig } = decodeAuthKid(fetchMock, i)
      expect(header.kid).toBe('kid-profile')
      const expected = crypto
        .createHmac('sha256', 'secret-profile')
        .update(signingInput)
        .digest('base64url')
      expect(sig).toBe(expected)
    }
    // hosted mode routes through the hub base URL
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://registration.evenfire.ai/api/v1/invitations-flow/invitations'
    )
  })

  it('admin SEND and VALIDATE sign with the control-ui host credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ sent: true, registered: true }))
      .mockResolvedValueOnce(okJson({ valid: true, email: 'a@b.c', invitationUuid: 'u' }))
    vi.stubGlobal('fetch', fetchMock)

    await registerAndSendControlAdminInvitation('a@b.c', 'uuid-2', '2026-01-01', '2026-02-01')
    await validateControlAdminInvitationToken('tok', 'a@b.c')

    for (const i of [0, 1]) {
      const { header, signingInput, sig } = decodeAuthKid(fetchMock, i)
      expect(header.kid).toBe('kid-control')
      const expected = crypto
        .createHmac('sha256', 'secret-control')
        .update(signingInput)
        .digest('base64url')
      expect(sig).toBe(expected)
    }
  })

  it('remote mode signs with the env credential, never touches enrollment or /public/tenants', async () => {
    cfg.memberRegistrationMode = 'remote'
    cfg.memberRegistrationServiceBaseUrl = 'http://member-registration-service.local:8092/api/v1'
    cfg.memberRegistrationServiceHmacSecret = 'env-secret'
    cfg.memberRegistrationServiceHmacKid = 'env-kid'
    cfg.memberRegistrationTenantId = 'example-dev'
    const fetchMock = vi.fn().mockResolvedValue(okJson({ sent: true, registered: true }))
    vi.stubGlobal('fetch', fetchMock)

    await registerAndSendInvitation('a@b.c', 'uuid-3', 'team', '2026-01-01', '2026-02-01')

    expect(enrollment.ensureEnrollment).not.toHaveBeenCalled()
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'http://member-registration-service.local:8092/api/v1/invitations-flow/invitations'
    )
    expect(String(url)).not.toContain('/public/tenants')
    const { header } = decodeAuthKid(fetchMock, 0)
    expect(header.kid).toBe('env-kid')
  })
})
