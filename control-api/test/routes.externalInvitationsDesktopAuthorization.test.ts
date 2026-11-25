import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'

const flow = vi.hoisted(() => ({
  validateInvitationFlowToken: vi.fn(),
  storeDesktopAuthorizationToken: vi.fn(),
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => flow)

const directory = vi.hoisted(() => ({
  acceptInvitationForEmailInTransaction: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setInvitationPasswordForEmail: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
  verifyUserPassword: vi.fn(),
}))
vi.mock('../src/services/directory/index.js', () => directory)

const session = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
}))

// Only the session check is replaced: it stands for a verified session. The
// body-mismatch guard and the rest of the route's chain are the real ones.
vi.mock('../src/middleware/externalSessionAuth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/middleware/externalSessionAuth.js')>()
  return {
    ...actual,
    requireValidExternalSessionToken: (
      req: express.Request & { externalAuth?: Record<string, unknown> },
      _res: express.Response,
      next: express.NextFunction
    ) => {
      req.externalAuth = { ...session.claims }
      next()
    },
  }
})

// The users table as the route's account read sees it, keyed by user id. Only
// the transaction is replaced: the route's read is the real lockUserById.
const accounts = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  query: vi.fn(),
}))
vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    withTransaction: async (work: (db: { query: typeof accounts.query }) => unknown) =>
      work({ query: accounts.query }),
  }
})

const SESSION_CLAIMS = {
  userId: 'session-user',
  email: 'session-member@example.invalid',
  teamId: null,
  role: 'member',
  authGeneration: 1,
}

function accountRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_CLAIMS.userId,
    email: SESSION_CLAIMS.email,
    name: null,
    picture: null,
    lifecycle_state: 'active',
    lifecycle_version: 1,
    ...overrides,
  }
}

function app(): express.Express {
  const value = express()
  value.use(express.json())
  value.use(createExternalInvitationsRouter())
  return value
}

describe('POST /external/invitations/desktop-authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.claims = { ...SESSION_CLAIMS }
    flow.storeDesktopAuthorizationToken.mockResolvedValue(undefined)
    accounts.rows = new Map([[SESSION_CLAIMS.userId, accountRow()]])
    accounts.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!/FROM users\s+WHERE id = \$1/.test(sql)) throw new Error(`unexpected query: ${sql}`)
      const row = accounts.rows.get(String(params[0]))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    })
  })

  it('uses the session email and ignores a different body email', async () => {
    // The body carries dev's fields: the session's own user id (so the
    // unchanged mismatch guard lets it through), another member's email, and a
    // password the directory would accept.
    directory.verifyUserPassword.mockResolvedValue(true)

    const response = await request(app()).post('/external/invitations/desktop-authorization').send({
      userId: SESSION_CLAIMS.userId,
      email: 'other-member@example.invalid',
      password: 'fixture-current-password',
    })

    expect(response.status).toBe(200)
    expect(flow.storeDesktopAuthorizationToken).toHaveBeenCalledOnce()
    expect(flow.storeDesktopAuthorizationToken).toHaveBeenCalledWith(
      SESSION_CLAIMS.email,
      response.body.authorizationToken
    )
    expect(flow.storeDesktopAuthorizationToken).not.toHaveBeenCalledWith(
      'other-member@example.invalid',
      expect.anything()
    )
  })

  it('authorizes without a password', async () => {
    const response = await request(app())
      .post('/external/invitations/desktop-authorization')
      .send({})

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      authorizationToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      expiresInSeconds: 120,
    })
    expect(flow.storeDesktopAuthorizationToken).toHaveBeenCalledOnce()
    expect(flow.storeDesktopAuthorizationToken).toHaveBeenCalledWith(
      SESSION_CLAIMS.email,
      response.body.authorizationToken
    )
    expect(directory.verifyUserPassword).not.toHaveBeenCalled()
  })

  it('stores the token under the live account email, not a stale session email', async () => {
    // A v1 session keeps the email it was issued with; an admin has since
    // moved the account to a new address.
    session.claims = { ...SESSION_CLAIMS, email: 'old-address@example.invalid' }
    accounts.rows.set(SESSION_CLAIMS.userId, accountRow({ email: 'new-address@example.invalid' }))

    const response = await request(app())
      .post('/external/invitations/desktop-authorization')
      .send({})

    expect(response.status).toBe(200)
    expect(accounts.query).toHaveBeenCalledWith(expect.stringMatching(/FROM users/), [
      SESSION_CLAIMS.userId,
    ])
    expect(flow.storeDesktopAuthorizationToken).toHaveBeenCalledOnce()
    expect(flow.storeDesktopAuthorizationToken).toHaveBeenCalledWith(
      'new-address@example.invalid',
      response.body.authorizationToken
    )
    expect(flow.storeDesktopAuthorizationToken).not.toHaveBeenCalledWith(
      'old-address@example.invalid',
      expect.anything()
    )
  })

  it.each([
    ['no row', undefined],
    ['a retired row', accountRow({ lifecycle_state: 'retired' })],
  ])('refuses a session whose account has %s', async (_label, row) => {
    if (row) accounts.rows.set(SESSION_CLAIMS.userId, row)
    else accounts.rows.delete(SESSION_CLAIMS.userId)

    const response = await request(app())
      .post('/external/invitations/desktop-authorization')
      .send({ email: 'other-member@example.invalid' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(accounts.query).toHaveBeenCalledWith(expect.stringMatching(/FROM users/), [
      SESSION_CLAIMS.userId,
    ])
    expect(flow.storeDesktopAuthorizationToken).not.toHaveBeenCalled()
  })
})
