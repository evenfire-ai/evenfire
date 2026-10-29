import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGfsUserHome, restoreGfsUserHomeOwner, retryGfsUserHome } from '../api'

afterEach(() => vi.unstubAllGlobals())

describe('GFS user-home operator API', () => {
  it('uses the specified detail and mutation routes and bodies', async () => {
    const response = {
      home: { userId: 'user/id', email: null, state: 'retired', conflictDetail: null },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect((await getGfsUserHome('user/id')).home.email).toBeNull()
    await retryGfsUserHome('user/id', 'new-name')
    await restoreGfsUserHomeOwner('user/id')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/gfs/user-homes/user%2Fid')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      body: '{"storageUsername":"new-name"}',
    })
    expect(String(fetchMock.mock.calls[1][0])).toContain('/gfs/user-homes/user%2Fid/retry')
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST', body: undefined })
    expect(String(fetchMock.mock.calls[2][0])).toContain('/gfs/user-homes/user%2Fid/restore-owner')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('preserves a validation error and accepts a subsequent valid retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_name' }), { status: 422 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ home: { state: 'pending' } }), { status: 202 })
      )
    vi.stubGlobal('fetch', fetchMock)
    await expect(retryGfsUserHome('user', '..')).rejects.toMatchObject({
      status: 422,
      code: 'invalid_name',
    })
    await expect(retryGfsUserHome('user', 'member')).resolves.toEqual({
      home: { state: 'pending' },
    })
  })

  it('sends no name on Retry and preserves a 409 before a successful retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'home_not_retryable' }), { status: 409 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ home: { state: 'pending' } }), { status: 202 })
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(retryGfsUserHome('user')).rejects.toMatchObject({
      status: 409,
      code: 'home_not_retryable',
    })
    await expect(retryGfsUserHome('user')).resolves.toEqual({ home: { state: 'pending' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' })
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('preserves resolved conflict details on a detail response', async () => {
    const detail = {
      code: 'ownership_conflict',
      ownerGrant: { permissions: ['read'], inherit: false },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ home: { state: 'conflict', conflictDetail: detail } }), {
          status: 200,
        })
      )
    )
    expect((await getGfsUserHome('user')).home.conflictDetail).toEqual(detail)
  })
})
