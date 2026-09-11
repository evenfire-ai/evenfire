import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteManagedUser } from '../src/services/memberManagementService.js'

const controlApiClientMock = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
}))

vi.mock('../src/controlApiClient.js', () => controlApiClientMock)

describe('deleteManagedUser', () => {
  beforeEach(() => controlApiClientMock.controlApiRequest.mockReset())

  it('forwards governed retirement input through the Control API boundary', async () => {
    controlApiClientMock.controlApiRequest.mockResolvedValueOnce({ ok: true })

    await expect(
      deleteManagedUser('user-2', 'user-session-token', {
        reason: 'team access no longer required',
        idempotencyKey: 'retire-user-2-v1',
        correlationId: '11111111-1111-4111-8111-111111111111',
      })
    ).resolves.toEqual({ ok: true })

    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'DELETE',
      '/external/members/user-2',
      {
        body: { reason: 'team access no longer required' },
        userSessionToken: 'user-session-token',
        extraHeaders: {
          'idempotency-key': 'retire-user-2-v1',
          'x-correlation-id': '11111111-1111-4111-8111-111111111111',
        },
      }
    )
  })
})
