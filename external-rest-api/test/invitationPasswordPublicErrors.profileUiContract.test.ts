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
  auth?: 'session'
  serviceError?: string
  memberServiceError?: string
  acceptError?: string
  status: number
  body: Record<string, string>
  componentPreview: 'reset' | 'accepted_member'
  terminal: boolean
  uiMessage: string
}

const contract = contractDocument as Record<string, ContractEntry>

// Witness credentials and the rejection credentials are deliberately
// different: the rejection request must not prove the witness by reusing its
// proof or its issued session.
const WITNESS_PROOF = 'synthetic-cookie-witness-proof'
const WITNESS_EMAIL = 'cookie-witness@example.invalid'
const WITNESS_SESSION = 'synthetic-witness-profile-session'
const CONTRACT_PROOF = 'synthetic-contract-proof'
const CONTRACT_EMAIL = 'invitee@example.com'
const CONTRACT_SESSION = 'synthetic-contract-session'

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

// One observation helper for the positive witness and for every rejection:
// disabling the cookie writer makes every case fail at its witness first.
function observedSetCookie(response: request.Response): string {
  return String(response.headers['set-cookie'] ?? '')
}

function configureContractMocks(entry: ContractEntry) {
  serviceMock.getInvitationByToken.mockResolvedValue({
    id: 'invitation-row-1',
    email: CONTRACT_EMAIL,
    purpose: entry.previewPurpose,
    status: 'pending',
  })
  serviceMock.acceptInvitation.mockImplementation(async (token: string) => {
    if (token === WITNESS_PROOF) {
      return {
        data: {
          token: WITNESS_SESSION,
          userId: 'cookie-witness-user',
          email: WITNESS_EMAIL,
          status: 'accepted',
          passwordPending: true,
        },
      }
    }
    if (entry.acceptError) return { error: entry.acceptError }
    throw new Error(`unexpected accept lookup for ${token}`)
  })
  if (entry.auth === 'session') {
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'contract-session-user',
      email: CONTRACT_EMAIL,
    })
  }
  if (entry.serviceError) {
    serviceMock.setupInvitationPasswordWithToken.mockResolvedValue({ error: entry.serviceError })
  }
  if (entry.memberServiceError) {
    serviceMock.setupInvitationPassword.mockResolvedValue({ error: entry.memberServiceError })
  }
}

// A real router acceptance with the witness proof, on its own rate-limit
// identity, issues the product session cookie the rejection case must lack.
async function issueWitnessSessionCookie(sourceIp: string) {
  return request(makeApp())
    .post('/invitations/accept')
    .set('x-forwarded-for', sourceIp)
    .send({ token: WITNESS_PROOF, email: WITNESS_EMAIL })
}

async function edgeResponse(entry: ContractEntry, sourceIp: string) {
  const path = entry.route === 'password' ? '/invitations/password' : '/invitations/password-reset'
  const edge = request(makeApp()).post(path).set('x-forwarded-for', sourceIp)
  if (entry.auth === 'session') {
    edge.set('authorization', `Bearer ${CONTRACT_SESSION}`)
  }
  return edge.send({
    token: CONTRACT_PROOF,
    email: CONTRACT_EMAIL,
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
      configureContractMocks(entry)

      // Positive witness in this same test, before the rejection: the real
      // router issues a product session cookie for a successful acceptance.
      const witness = await issueWitnessSessionCookie(`198.51.100.${120 + index}`)
      expect(witness.status, name).toBe(200)
      expect(observedSetCookie(witness)).toContain(`profile_session=${WITNESS_SESSION}`)

      const response = await edgeResponse(entry, `198.51.100.${20 + index}`)

      expect(response.status).toBe(entry.status)
      expect(response.body).toEqual(entry.body)
      expect(observedSetCookie(response)).not.toMatch(/profile_session=[^;]+/)

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
