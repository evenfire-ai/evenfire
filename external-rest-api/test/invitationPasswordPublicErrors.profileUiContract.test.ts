import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ProfileApiError, apiSend } from '../../profile-ui/lib/api.js'
import { isTerminalPasswordError } from '../../profile-ui/lib/invitationErrors.js'
import contractDocument from '../../tests/contracts/invitation-password-public-errors.json'
import { createInvitationsRouter } from '../src/routes/invitations.js'

type ContractEntry = {
  route: 'password' | 'password-reset'
  previewPurpose?: 'password_reset' | 'member_invitation'
  serviceError?: string
  acceptError?: string
  status: number
  body: Record<string, string>
  componentPreview: 'reset' | 'accepted_member'
  terminal: boolean
  uiMessage: string
}

const contract = contractDocument as Record<string, ContractEntry>

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  createDesktopAuthorization: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setupInvitationPassword: vi.fn(),
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/invitationsService.js', () => serviceMock)
vi.mock('../src/services/invitationPasswordService.js', () => ({
  setupInvitationPassword: serviceMock.setupInvitationPassword,
  setupInvitationPasswordWithToken: serviceMock.setupInvitationPasswordWithToken,
}))

function makeApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(createInvitationsRouter())
  return app
}

async function edgeResponse(name: string, entry: ContractEntry, sourceIp: string) {
  serviceMock.getInvitationByToken.mockResolvedValue({
    id: 'invitation-row-1',
    email: 'invitee@example.com',
    purpose: entry.previewPurpose,
    status: 'pending',
  })
  if (entry.acceptError) {
    serviceMock.acceptInvitation.mockResolvedValue({ error: entry.acceptError })
  }
  if (entry.serviceError) {
    serviceMock.setupInvitationPasswordWithToken.mockResolvedValue({ error: entry.serviceError })
  }

  const path = entry.route === 'password' ? '/invitations/password' : '/invitations/password-reset'
  return request(makeApp()).post(path).set('x-forwarded-for', sourceIp).send({
    token: 'synthetic-contract-proof',
    email: 'invitee@example.com',
    invitationId: 'invitation-row-1',
    password: 'Synthetic-Contract-Password-123',
  })
}

describe('invitation password public errors reach Profile UI classification', () => {
  beforeEach(() => {
    Object.values(serviceMock).forEach(mock => mock.mockReset())
    authTokenMock.verifyToken.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(Object.entries(contract).map(([name, entry], index) => [name, entry, index] as const))(
    'classifies the real edge %s body through the Profile UI parser',
    async (name, entry, index) => {
      const response = await edgeResponse(name, entry, `198.51.100.${20 + index}`)

      expect(response.status).toBe(entry.status)
      expect(response.body).toEqual(entry.body)
      expect(String(response.headers['set-cookie'] ?? '')).not.toMatch(/profile_session=[^;]+/)

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(response.body), {
            status: response.status,
            statusText: 'Synthetic Edge Status',
            headers: { 'content-type': 'application/json' },
          })
        )
      )

      const parsed = await apiSend('POST', '/api/v1/invitations/password-reset', {}).catch(
        error => error
      )

      expect(parsed).toBeInstanceOf(ProfileApiError)
      expect((parsed as ProfileApiError).status).toBe(entry.status)
      expect((parsed as ProfileApiError).code).toBe(entry.body.code ?? entry.body.error)
      expect(isTerminalPasswordError(parsed)).toBe(entry.terminal)
      expect(fetch).toHaveBeenCalledOnce()
    }
  )
})
