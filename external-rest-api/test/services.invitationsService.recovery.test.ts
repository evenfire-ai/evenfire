import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupInvitationPasswordWithToken } from '../src/services/invitationsService.js'

const fetchMock = vi.fn()

describe('setupInvitationPasswordWithToken', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('preserves invalid recovery proof as a safe link error', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_invitation' }), { status: 400 })
    )

    await expect(
      setupInvitationPasswordWithToken(
        'synthetic-proof',
        'member@example.invalid',
        'synthetic-row-id',
        'synthetic-password'
      )
    ).resolves.toEqual({ error: 'invalid_invitation' })
  })

  it('continues to identify password-policy rejections as invalid passwords', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_password' }), { status: 400 })
    )

    await expect(
      setupInvitationPasswordWithToken(
        'synthetic-proof',
        'member@example.invalid',
        'synthetic-row-id',
        'short'
      )
    ).resolves.toEqual({ error: 'invalid_password' })
  })
})
