import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlApiError } from '../src/controlApiClient.js'
import {
  acceptInvitation,
  setupInvitationPassword,
  setupInvitationPasswordWithToken,
} from '../src/services/invitationsService.js'

const client = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/controlApiClient.js')>()),
  controlApiRequest: client.request,
}))

describe('invitation service error and token boundaries', () => {
  beforeEach(() => client.request.mockReset())

  it('never converts Control API unavailability into not-pending or invalid-password', async () => {
    const unavailable = new ControlApiError('unavailable', 503, {
      error: { code: 'authority_unavailable' },
    })

    for (const operation of [
      () => acceptInvitation('flow-token', 'user@example.com', 'v2'),
      () =>
        setupInvitationPassword(
          { userId: 'user-1', email: 'user@example.com', sessionToken: 'session-token' },
          'inv-1',
          'valid-password'
        ),
      () =>
        setupInvitationPasswordWithToken({
          token: 'flow-token',
          email: 'user@example.com',
          invitationId: 'inv-1',
          password: 'valid-password',
          sessionContract: 'v2',
        }),
    ]) {
      client.request.mockRejectedValueOnce(unavailable)
      await expect(operation()).rejects.toBe(unavailable)
    }
  })

  it('discards any transitional session representation from atomic password setup', async () => {
    client.request.mockResolvedValueOnce({
      id: 'inv-1',
      email: 'user@example.com',
      passwordUpdated: true,
      token: 'must-never-reach-browser-route',
    })

    const result = await setupInvitationPasswordWithToken({
      token: 'flow-token',
      email: 'user@example.com',
      invitationId: 'inv-1',
      password: 'valid-password',
      sessionContract: 'v2',
    })

    expect(result.data).toMatchObject({ id: 'inv-1', passwordUpdated: true })
    expect(result.data).not.toHaveProperty('token')
  })
})
