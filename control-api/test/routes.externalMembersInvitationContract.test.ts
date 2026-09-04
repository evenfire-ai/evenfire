import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import { createExternalMembersRouter } from '../src/routes/external/members.js'
import {
  MemberRegistrationMisconfiguredError,
  MemberRegistrationUnavailableError,
  memberRegistrationErrorResponse,
} from '../src/services/memberRegistrationErrors.js'

const invitationErrorContract = JSON.parse(
  readFileSync(
    new URL('../../tests/contracts/external-member-invitation-errors.json', import.meta.url),
    'utf8'
  )
) as Record<string, { control: { status: number; body: { error: string } } }>

const memberRegistrationErrorContract = JSON.parse(
  readFileSync(
    new URL('../../tests/contracts/member-registration-public-errors.json', import.meta.url),
    'utf8'
  )
) as Record<string, { control: { status: number; body: { error: string } } }>

const directoryMock = vi.hoisted(() => ({
  createManagedInvitationForUser: vi.fn(),
  deleteManagedMemberForUser: vi.fn(),
  deleteManagedUserForUser: vi.fn(),
  externalManagedInvitationResponse: vi.fn((value: Record<string, unknown>) => value),
  listManageableTeamsForUser: vi.fn(),
  listManagedMembersForUser: vi.fn(),
  listManagedPendingInvitationsForUser: vi.fn(),
  resendManagedInvitationForUser: vi.fn(),
  revokeManagedInvitationForUser: vi.fn(),
  updateManagedMemberRoleForUser: vi.fn(),
}))

const rateLimitMock = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'manager-1',
    }
    next()
  },
}))
vi.mock('../src/services/directory/index.js', async () => {
  const actual = await import('../src/services/directory/membership.js')
  directoryMock.createManagedInvitationForUser.mockImplementation(
    actual.createManagedInvitationForUser
  )
  return directoryMock
})
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalMembersRouter())
  return app
}

describe('external member invitation producer contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
  })

  it.each([
    {
      contract: 'invalidEmail',
      label: 'invalid email',
      body: { email: 'not-an-email', teams: [] },
    },
    {
      contract: 'invalidPayload',
      label: 'empty assignments',
      body: { email: 'invitee@example.com', teams: [] },
    },
    {
      contract: 'invalidName',
      label: 'overlong name',
      body: {
        email: 'invitee@example.com',
        name: 'a'.repeat(121),
        teams: [{ teamId: 'team-1', role: 'member' }],
      },
    },
    {
      contract: 'tooManyTeams',
      label: 'too many teams',
      body: {
        email: 'invitee@example.com',
        teams: Array.from({ length: 51 }, (_, index) => ({
          teamId: `team-${index}`,
          role: 'member',
        })),
      },
    },
  ])('emits the shared wire response for $label', async ({ contract, body }) => {
    const expected = invitationErrorContract[contract].control
    await request(makeApp())
      .post('/external/members/invitations')
      .send(body)
      .expect(expected.status, expected.body)

    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_member_mutation:user:manager-1',
      10
    )
  })

  it.each([
    {
      contract: 'unavailable',
      error: new MemberRegistrationUnavailableError(),
    },
    {
      contract: 'misconfigured',
      error: new MemberRegistrationMisconfiguredError('private configuration detail'),
    },
  ])('emits the shared $contract member-registration failure', ({ contract, error }) => {
    const produced = memberRegistrationErrorResponse(error)
    expect(produced).not.toBeNull()
    expect({ status: produced!.status, body: { error: produced!.error } }).toEqual(
      memberRegistrationErrorContract[contract].control
    )
  })
})
