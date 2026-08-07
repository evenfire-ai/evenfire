import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createDirectoryRouter } from '../src/routes/directory.js'

const controlApiMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const directoryServiceMock = vi.hoisted(() => ({
  searchDirectory: vi.fn(),
}))

vi.mock('../src/authToken.js', () => controlApiMock)
vi.mock('../src/services/directoryService.js', () => directoryServiceMock)

describe('routes/directory', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9999999999,
  }

  beforeEach(() => {
    controlApiMock.verifyToken.mockReset()
    directoryServiceMock.searchDirectory.mockReset()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createDirectoryRouter())
    return app
  }

  it('requires user authentication', async () => {
    const app = makeApp()
    await request(app).get('/directory/search?q=alice').expect(401)
    expect(directoryServiceMock.searchDirectory).not.toHaveBeenCalled()
  })

  it('rejects bad bearer token', async () => {
    controlApiMock.verifyToken.mockReturnValueOnce(null)
    const app = makeApp()

    await request(app)
      .get('/directory/search?q=alice')
      .set('authorization', 'Bearer bad-token')
      .expect(401)
    expect(directoryServiceMock.searchDirectory).not.toHaveBeenCalled()
  })

  it('returns empty items when query is blank', async () => {
    controlApiMock.verifyToken.mockReturnValueOnce(claims)
    const app = makeApp()

    const response = await request(app)
      .get('/directory/search?q=')
      .set('authorization', 'Bearer good-token')
      .expect(200)

    expect(response.body).toEqual({ items: [] })
    expect(directoryServiceMock.searchDirectory).not.toHaveBeenCalled()
  })

  it('searches using authenticated teamId', async () => {
    controlApiMock.verifyToken.mockReturnValueOnce(claims)
    directoryServiceMock.searchDirectory.mockResolvedValueOnce({ items: [{ id: 'u1' }] })
    const app = makeApp()

    const response = await request(app)
      .get('/directory/search?q=alice&teamId=other-team')
      .set('authorization', 'Bearer good-token')
      .expect(200)

    expect(response.body).toEqual({ items: [{ id: 'u1' }] })
    expect(directoryServiceMock.searchDirectory).toHaveBeenCalledWith(
      'team-1',
      'alice',
      'good-token'
    )
  })
})
