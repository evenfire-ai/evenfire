import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({
  memberRegistrationMode: 'offline' as 'remote' | 'offline',
  memberRegistrationServiceBaseUrl: 'https://reg.example/api/v1',
  inviteAcceptBaseUrl: 'https://profile.example/',
  desktopExternalRestApiBaseUrl: 'http://x',
  desktopRpcProxyBaseUrl: 'http://x',
  desktopProfileUiBaseUrl: 'http://x',
  desktopAppName: 'Evenfire',
}))
vi.mock('../src/config.js', () => ({ config: mockConfig }))
vi.mock('../src/utils/auth/memberRegistrationSigner.js', () => ({
  signMemberRegistrationJwt: () => 'test-jwt',
}))

import {
  buildInviteAcceptUrl,
  registerAndSendInvitation,
  storeDesktopAuthorizationToken,
  validateInvitationFlowToken,
} from '../src/services/invitationFlowRegistrationService.js'

const getInvitationByToken = vi.fn()
vi.mock('../src/services/directory/index.js', () => ({ getInvitationByToken }))

const fetchSpy = vi.fn()
beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ sent: true, registered: true }),
  })
  vi.stubGlobal('fetch', fetchSpy)
  mockConfig.memberRegistrationMode = 'offline'
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildInviteAcceptUrl', () => {
  it('joins the accept base url and token, trimming trailing slashes', () => {
    expect(buildInviteAcceptUrl('tok-123')).toBe('https://profile.example/invitations/tok-123')
  })
})

describe('registerAndSendInvitation — offline vs remote', () => {
  it('offline: does not call fetch and logs no token', async () => {
    mockConfig.memberRegistrationMode = 'offline'
    await registerAndSendInvitation('a@b.com', 'tok-123', 'Team', 'i', 'e', {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('remote: calls fetch against the registration service', async () => {
    mockConfig.memberRegistrationMode = 'remote'
    await registerAndSendInvitation('a@b.com', 'tok-123', 'Team', 'i', 'e', {})
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/invitations-flow/invitations')
  })
})

describe('validateInvitationFlowToken — offline', () => {
  beforeEach(() => {
    mockConfig.memberRegistrationMode = 'offline'
    getInvitationByToken.mockReset()
  })

  it('echoes the input token as invitationUuid for a valid invitation', async () => {
    // shaped like invitationResponse — intentionally has NO `token` field
    getInvitationByToken.mockResolvedValue({ id: 'row-id', email: 'a@b.com', status: 'pending' })
    const result = await validateInvitationFlowToken('  tok-123  ', 'A@B.com')
    expect(getInvitationByToken).toHaveBeenCalledWith('tok-123')
    expect(result).toEqual({ email: 'a@b.com', invitationUuid: 'tok-123' })
  })

  it('throws when the invitation is missing/invalid', async () => {
    getInvitationByToken.mockResolvedValue(null)
    await expect(validateInvitationFlowToken('nope')).rejects.toThrow()
  })

  it('throws when the supplied email does not match', async () => {
    getInvitationByToken.mockResolvedValue({ id: 'row-id', email: 'a@b.com', status: 'pending' })
    await expect(validateInvitationFlowToken('tok-123', 'other@b.com')).rejects.toThrow()
  })
})

describe('storeDesktopAuthorizationToken — offline vs remote', () => {
  it('offline: does not call fetch', async () => {
    mockConfig.memberRegistrationMode = 'offline'
    await storeDesktopAuthorizationToken('a@b.com', 'auth-tok')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('remote: calls fetch against the registration service', async () => {
    mockConfig.memberRegistrationMode = 'remote'
    await storeDesktopAuthorizationToken('a@b.com', 'auth-tok')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/invitations-flow/desktop-authorizations')
  })
})
