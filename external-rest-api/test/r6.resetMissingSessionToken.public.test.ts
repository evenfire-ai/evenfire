import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createInvitationsRouter } from '../src/routes/invitations.js'

const invitationService = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  createDesktopAuthorization: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setupInvitationPassword: vi.fn(),
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('../src/services/invitationsService.js', () => invitationService)
vi.mock('../src/authToken.js', () => ({ verifyToken: vi.fn(() => null) }))

const resetPreview = {
  id: 'r6-reset-row',
  email: 'r6-member@example.invalid',
  purpose: 'password_reset',
  status: 'pending',
  userId: 'r6-member-id',
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createInvitationsRouter())
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  invitationService.getInvitationByToken.mockResolvedValue(resetPreview)
})

describe('R6 reset completion session-token fail-closed contract', () => {
  it.each([
    ['missing', { ...resetPreview, passwordUpdated: true }],
    ['empty', { ...resetPreview, token: '', passwordUpdated: true }],
  ])(
    'does not authenticate a completion response with an %s session token',
    async (_label, body) => {
      invitationService.setupInvitationPasswordWithToken.mockResolvedValue(body)

      const response = await request(makeApp()).post('/invitations/password').send({
        token: 'r6-synthetic-one-use-reset-proof',
        email: resetPreview.email,
        invitationId: resetPreview.id,
        password: 'R6-synthetic-new-password',
      })

      expect(response.status).toBe(502)
      expect(response.body).toEqual({ error: 'Failed to restore account session' })
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toContain('r6-synthetic-one-use-reset-proof')
      expect(invitationService.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
    }
  )
})
