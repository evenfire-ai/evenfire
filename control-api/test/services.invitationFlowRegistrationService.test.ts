import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAndSendInvitations } from '../src/services/invitationFlowRegistrationService.js'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('../src/config.js', () => ({
  config: {
    desktopAppName: 'Evenfire',
    desktopExternalRestApiBaseUrl: 'https://api.example.test',
    desktopProfileUiBaseUrl: 'https://profile.example.test',
    desktopRpcProxyBaseUrl: 'https://rpc.example.test',
  },
}))

vi.mock('../src/memberRegistrationServiceClient.js', () => ({
  memberRegistrationServiceRequest: requestMock,
}))

describe('registerAndSendInvitations', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('calls the existing invitation endpoint sequentially and reports each result', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    requestMock.mockImplementation(async (_method: string, _path: string, options: unknown) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      await new Promise(resolve => setTimeout(resolve, 5))
      activeRequests -= 1
      const body = (options as { body: { invitationUuid: string } }).body
      if (body.invitationUuid === 'invite-two') throw new Error('delivery rejected')
      return { sent: true, registered: true }
    })

    const result = await registerAndSendInvitations([
      {
        email: 'one@example.test',
        invitationUuid: 'invite-one',
        teamName: 'Support',
        teamNames: ['Support'],
        purpose: 'member_invitation',
        issuedAt: '2026-07-16T10:00:00.000Z',
        expiresAt: '2026-07-18T10:00:00.000Z',
      },
      {
        email: 'two@example.test',
        invitationUuid: 'invite-two',
        teamName: null,
        teamNames: [],
        purpose: 'member_invitation',
        issuedAt: '2026-07-16T10:00:00.000Z',
        expiresAt: '2026-07-18T10:00:00.000Z',
      },
      {
        email: 'three@example.test',
        invitationUuid: 'invite-three',
        teamName: null,
        teamNames: [],
        purpose: 'member_invitation',
        issuedAt: '2026-07-16T10:00:00.000Z',
        expiresAt: '2026-07-18T10:00:00.000Z',
      },
    ])

    expect(maxActiveRequests).toBe(1)
    expect(requestMock).toHaveBeenCalledTimes(3)
    expect(requestMock.mock.calls.map(([, path]) => path)).toEqual([
      '/invitations-flow/invitations',
      '/invitations-flow/invitations',
      '/invitations-flow/invitations',
    ])
    expect(result).toEqual({
      results: [
        { invitationUuid: 'invite-one', sent: true },
        { invitationUuid: 'invite-two', sent: false, error: 'delivery rejected' },
        { invitationUuid: 'invite-three', sent: true },
      ],
    })
  })
})
