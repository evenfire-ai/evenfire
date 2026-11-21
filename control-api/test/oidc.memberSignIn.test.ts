import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signInOidcVerifiedMember } from '../src/services/auth/oidcMemberSignIn.js'

const { issueExternalUserSession, currentMemberMembership } = vi.hoisted(() => ({
  issueExternalUserSession: vi.fn(),
  currentMemberMembership: vi.fn(),
}))

vi.mock('../src/services/auth/externalSessionIssuance.js', () => ({ issueExternalUserSession }))
vi.mock('../src/services/directory/login.js', () => ({ currentMemberMembership }))

const policy = { issueV1: true, acceptV1: true } as never

function fakeTransaction(rows: Array<Record<string, unknown>>) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length })
  const transaction = vi.fn(async (work: (db: never) => Promise<unknown>) =>
    work({ query } as never)
  )
  return { query, transaction: transaction as never, calls: transaction }
}

function attributes(overrides: Record<string, unknown> = {}) {
  return {
    source: 'validated_id_token',
    email: 'Member@Example.TEST',
    emailVerified: true,
    ...overrides,
  } as never
}

const activeMember = {
  id: 'user-1',
  email: 'member@example.test',
  lifecycle_state: 'active',
  lifecycle_version: '7',
}

describe('OIDC member sign-in by verified email (dev spike)', () => {
  beforeEach(() => {
    issueExternalUserSession.mockReset()
    currentMemberMembership.mockReset()
  })

  it.each([
    ['email_missing', { email: undefined }],
    ['email_missing', { email: '   ' }],
    ['email_unverified', { emailVerified: false }],
    ['email_unverified', { emailVerified: undefined }],
  ])('refuses with %s before touching the database', async (reason, overrides) => {
    const db = fakeTransaction([activeMember])
    const result = await signInOidcVerifiedMember(
      { attributes: attributes(overrides), contract: 'v1', policy },
      { transaction: db.transaction }
    )
    expect(result).toEqual({ status: 'refused', reason })
    expect(db.calls).not.toHaveBeenCalled()
    expect(issueExternalUserSession).not.toHaveBeenCalled()
  })

  it.each([
    ['no_matching_member', []],
    ['ambiguous_member', [activeMember, { ...activeMember, id: 'user-2' }]],
    ['member_inactive', [{ ...activeMember, lifecycle_state: 'retired' }]],
  ])('refuses with %s and issues no session', async (reason, rows) => {
    const db = fakeTransaction(rows)
    const result = await signInOidcVerifiedMember(
      { attributes: attributes(), contract: 'v1', policy },
      { transaction: db.transaction }
    )
    expect(result).toEqual({ status: 'refused', reason })
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query.mock.calls[0]?.[1]).toEqual(['member@example.test'])
    expect(issueExternalUserSession).not.toHaveBeenCalled()
  })

  it('issues the shared member session for the one active member, under its row lock', async () => {
    const db = fakeTransaction([activeMember])
    currentMemberMembership.mockResolvedValue({ team_id: 'team-1', role: 'member', team_name: 'T' })
    issueExternalUserSession.mockResolvedValue({ token: 'session-token-fixture', contract: 'v1' })

    const result = await signInOidcVerifiedMember(
      { attributes: attributes(), contract: 'v1', policy },
      { transaction: db.transaction }
    )

    expect(result).toEqual({
      status: 'signed_in',
      userId: 'user-1',
      token: 'session-token-fixture',
      contract: 'v1',
    })
    expect(String(db.query.mock.calls[0]?.[0])).toMatch(
      /lower\(email\) = \$1[\s\S]*FOR NO KEY UPDATE/
    )
    expect(currentMemberMembership).toHaveBeenCalledWith(expect.anything(), {
      id: 'user-1',
      email: 'member@example.test',
    })
    expect(issueExternalUserSession).toHaveBeenCalledWith(
      {
        contract: 'v1',
        userId: 'user-1',
        email: 'member@example.test',
        teamId: 'team-1',
        role: 'member',
        authGeneration: 7,
        authenticationMethods: ['oidc'],
      },
      expect.objectContaining({
        policy,
        lockedUser: { lifecycleState: 'active', lifecycleVersion: '7' },
      })
    )
  })
})
