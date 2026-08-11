import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalDirectoryRouter } from '../src/routes/external/directory.js'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  membership: vi.fn(),
  searchDirectory: vi.fn(),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: mocks.verify,
}))
vi.mock('../src/services/access/liveTeamAuthorization.js', () => ({
  getLiveTeamMembership: mocks.membership,
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: vi.fn(async () => ({ status: 'valid', identity: {} })),
  }
})
vi.mock('../src/services/directory/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/directory/index.js')>()
  return { ...actual, searchDirectory: mocks.searchDirectory }
})

function app() {
  const value = express()
  value.use(createExternalDirectoryRouter())
  return value
}

describe('external directory authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verify.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v1',
    })
    mocks.searchDirectory.mockResolvedValue({ items: [], nextCursor: null })
  })

  it('denies an ordinary member without executing the PII search', async () => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role: 'member' })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('forbidden')
    expect(mocks.searchDirectory).not.toHaveBeenCalled()
  })

  it.each(['admin', 'inviter'] as const)('allows a current %s to search', async role => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')

    expect(response.status).toBe(200)
    expect(mocks.searchDirectory).toHaveBeenCalledWith('team-1', 'person', undefined)
  })
})
