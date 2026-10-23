import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlApiError } from '../src/controlApiClient.js'
import {
  setupInvitationPassword,
  setupInvitationPasswordWithToken,
} from '../src/services/invitationPasswordService.js'
import { acceptInvitation } from '../src/services/invitationsService.js'

const client = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/controlApiClient.js')>()),
  controlApiRequest: client.request,
}))

describe('invitation service error and token boundaries', () => {
  beforeEach(() => client.request.mockReset())

  it('never converts Control API unavailability into not-pending or invalid-password', async () => {
    const unavailable = new ControlApiError('unavailable', 503, {
      error: 'authority_unavailable',
    })

    for (const operation of [
      () => acceptInvitation('flow-token', 'user@example.com', 'v2'),
      () =>
        setupInvitationPassword(
          { userId: 'user-1', email: 'user@example.com', sessionToken: 'synthetic-session-token' },
          'inv-1',
          'synthetic-valid-password'
        ),
      () =>
        setupInvitationPasswordWithToken(
          'flow-token',
          'user@example.com',
          'inv-1',
          'synthetic-valid-password'
        ),
    ]) {
      client.request.mockRejectedValueOnce(unavailable)
      await expect(operation()).rejects.toBe(unavailable)
    }
  })

  it('classifies a producer password_already_set rejection as a terminal domain error', async () => {
    client.request.mockRejectedValueOnce(
      new ControlApiError(
        'Control API POST /external/invitations/password failed (409): password_already_set',
        409,
        { error: 'password_already_set' }
      )
    )

    await expect(
      setupInvitationPassword(
        { userId: 'user-1', email: 'user@example.com', sessionToken: 'synthetic-session-token' },
        'inv-1',
        'synthetic-valid-password'
      )
    ).resolves.toEqual({ error: 'password_already_set' })
  })

  it('discards any transitional session representation from atomic password setup', async () => {
    client.request.mockResolvedValueOnce({
      id: 'inv-1',
      email: 'user@example.com',
      passwordUpdated: true,
      token: 'synthetic-must-never-reach-browser-route',
    })

    const result = await setupInvitationPasswordWithToken(
      'flow-token',
      'user@example.com',
      'inv-1',
      'synthetic-valid-password'
    )

    expect(result.data).toMatchObject({ id: 'inv-1', passwordUpdated: true })
    expect(result.data).not.toHaveProperty('token')
  })
})
