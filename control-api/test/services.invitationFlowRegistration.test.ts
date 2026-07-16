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
} from '../src/services/invitationFlowRegistrationService.js'

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
