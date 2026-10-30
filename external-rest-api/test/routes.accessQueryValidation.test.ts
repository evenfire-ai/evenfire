import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAccessRouter } from '../src/routes/access.js'

const auth = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', () => ({ verifyToken: auth.verifyToken }))

function app() {
  const value = express()
  value.use(createAccessRouter())
  return value
}

describe('access catalog query validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.verifyToken.mockReturnValue({ userId: 'user-1', exp: 2_000_000_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
  })

  it.each([
    'cursor=',
    'cursor=first&cursor=second',
    'families=',
    'families=team&families=host',
    'limit=',
    'limit=10&limit=20',
  ])('rejects malformed query %s before contacting Control API', async query => {
    const response = await request(app())
      .get(`/me/access/catalog?${query}`)
      .set('authorization', 'Bearer session-token')
      .expect(400)

    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves one value for every supported query field', async () => {
    await request(app())
      .get('/me/access/catalog?families=team%2Chost&limit=25&cursor=c3.value.signature')
      .set('authorization', 'Bearer session-token')
      .expect(200)

    expect(fetch).toHaveBeenCalledTimes(1)
    const requestUrl = String(vi.mocked(fetch).mock.calls[0]?.[0])
    expect(new URL(requestUrl).searchParams).toEqual(
      new URLSearchParams({
        families: 'team,host',
        limit: '25',
        cursor: 'c3.value.signature',
      })
    )
  })
})
