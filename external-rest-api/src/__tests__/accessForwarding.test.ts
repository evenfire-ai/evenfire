import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAccessRouter } from '../routes/access.js'

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  controlApiRequest: vi.fn(),
}))

vi.mock('../authToken.js', () => ({ verifyToken: mocks.verifyToken }))
vi.mock('../controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../controlApiClient.js')>()
  return { ...actual, controlApiRequest: mocks.controlApiRequest }
})

function app() {
  const value = express()
  value.use(express.json())
  value.use(createAccessRouter())
  return value
}

describe('aggregate access forwarding', () => {
  beforeEach(() => {
    mocks.verifyToken.mockReset()
    mocks.controlApiRequest.mockReset()
    mocks.verifyToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: '',
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v2',
    })
  })

  it('forwards the one session bearer and aggregate query without adding team identity', async () => {
    mocks.controlApiRequest.mockResolvedValue({
      contractVersion: '2',
      authorizationRevision: 'revision',
      complete: true,
      partialErrors: [],
      items: [],
    })

    const response = await request(app())
      .get('/me/access/catalog?types=host,context&limit=25')
      .set('authorization', 'Bearer user-session')

    expect(response.status).toBe(200)
    expect(mocks.controlApiRequest).toHaveBeenCalledWith('GET', '/external/access/catalog', {
      userSessionToken: 'user-session',
      query: { types: 'host,context', limit: '25', cursor: undefined },
    })
    expect(JSON.stringify(mocks.controlApiRequest.mock.calls)).not.toContain('teamId')
  })

  it('does not forward arbitrary upstream error fields from the access route', async () => {
    const { ControlApiError } = await import('../controlApiClient.js')
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError('raw', 503, {
        error: {
          code: 'authority_unavailable',
          message: 'postgres://secret@internal',
          details: { path: '/var/run/internal' },
        },
      })
    )

    const response = await request(app())
      .get('/me/access/catalog')
      .set('authorization', 'Bearer user-session')

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('authority_unavailable')
    expect(JSON.stringify(response.body)).not.toContain('postgres')
    expect(JSON.stringify(response.body)).not.toContain('/var/run/internal')
  })
})
