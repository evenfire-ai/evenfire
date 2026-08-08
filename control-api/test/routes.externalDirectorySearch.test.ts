import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalDirectoryRouter } from '../src/routes/external/directory.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const directory = vi.hoisted(() => ({
  authorizeLiveTeamMembership: vi.fn(),
  searchDirectory: vi.fn(),
}))

const limiter = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/services/rateLimiterService.js', () => limiter)

describe('external directory search', () => {
  const sessionToken = signExternalSessionToken({
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member',
  })

  function app() {
    const instance = express()
    instance.use(requireInternalToken)
    instance.use(createExternalDirectoryRouter())
    return instance
  }

  function search(query: string) {
    return request(app())
      .get(`/external/directory/search${query}`)
      .set('authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', sessionToken)
  }

  beforeEach(() => {
    directory.authorizeLiveTeamMembership.mockReset()
    directory.searchDirectory.mockReset()
    limiter.checkAndIncrement.mockReset()
    directory.authorizeLiveTeamMembership.mockResolvedValue({
      status: 'active',
      membership: { team_id: 'team-1', role: 'member', team_name: 'Team One' },
    })
    directory.searchDirectory.mockResolvedValue([
      { id: 'user-2', email: 'two@example.com', name: 'Two', display_name: 'Two' },
    ])
    limiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
  })

  it('searches only the matching live team with the supported result shape', async () => {
    await search('?teamId=team-1&q=two')
      .expect(200)
      .expect({
        items: [{ id: 'user-2', email: 'two@example.com', name: 'Two', display_name: 'Two' }],
      })

    expect(directory.authorizeLiveTeamMembership).toHaveBeenCalledWith('user-1', 'team-1')
    expect(limiter.checkAndIncrement).toHaveBeenCalledWith(
      'external-directory-search:user-1:team-1',
      30
    )
    expect(directory.searchDirectory).toHaveBeenCalledWith('team-1', 'two')
  })

  it.each(['?teamId=team-2&q=two', '?q=two'])(
    'rejects a missing or mismatched query team before search: %s',
    async query => {
      await search(query).expect(403).expect({ error: 'team_context_mismatch' })
      expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
      expect(directory.searchDirectory).not.toHaveBeenCalled()
    }
  )

  it('rejects an oversized query before rate-limit or search work', async () => {
    await search(`?teamId=team-1&q=${'a'.repeat(129)}`)
      .expect(400)
      .expect({ error: 'directory_query_too_long', maxLength: 128 })

    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(directory.searchDirectory).not.toHaveBeenCalled()
  })

  it('returns the standard 429 and never executes search when exhausted', async () => {
    limiter.checkAndIncrement.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 30_000,
      windowStartMs: Date.now(),
      count: 31,
    })

    const response = await search('?teamId=team-1&q=two').expect(429)

    expect(response.body).toMatchObject({ error: 'Too Many Requests' })
    expect(response.headers['retry-after']).toBeDefined()
    expect(directory.searchDirectory).not.toHaveBeenCalled()
  })
})
