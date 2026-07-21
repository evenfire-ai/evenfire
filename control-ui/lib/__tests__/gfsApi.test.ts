import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type GfsGrantError,
  type GfsGrantRequestBody,
  type GfsMutationResponse,
  deleteGfsGrant,
  deleteGfsShare,
  getGfsGrants,
  getGfsShares,
  postGfsShare,
  putGfsGrant,
} from '../api'

const resourceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const bulkGrantWithHost = {
  resourceId,
  permissions: ['read'],
  subjects: [{ type: 'host', id: '1st:mcp-host/standalone' }],
} satisfies GfsGrantRequestBody

const singularContextResponse = {
  ok: true,
  resourceId,
  updated: [{ type: 'context', id: 'run-context' }],
  count: 1,
} satisfies GfsMutationResponse

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Bad Request',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('GFS mutation API contract', () => {
  it('lists and revokes persisted access through resource-scoped endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200, { items: [] }))
      .mockResolvedValueOnce(makeResponse(200, { items: [] }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }))

    await expect(getGfsGrants(resourceId)).resolves.toEqual({ items: [] })
    await expect(getGfsShares(resourceId)).resolves.toEqual({ items: [] })
    await expect(deleteGfsGrant('grant/id')).resolves.toBeUndefined()
    await expect(deleteGfsShare('share/id')).resolves.toBeUndefined()

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/api/v1/gfs/grants?drive=main&resourceId=${resourceId}`
    )
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      `/api/v1/gfs/shares?drive=main&resourceId=${resourceId}`
    )
    expect(String(fetchMock.mock.calls[2][0])).toContain('/api/v1/gfs/grants/grant%2Fid')
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE' })
    expect(String(fetchMock.mock.calls[3][0])).toContain('/api/v1/gfs/shares/share%2Fid')
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'DELETE' })
  })

  it('keeps host grants and singular context responses in the client contract', () => {
    expect(bulkGrantWithHost.subjects[0]).toEqual({
      type: 'host',
      id: '1st:mcp-host/standalone',
    })
    expect(singularContextResponse.updated[0]).toEqual({
      type: 'context',
      id: 'run-context',
    })
  })

  it('preserves the stable error envelope for grants', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, {
        error: 'subjects_invalid',
        message: 'The subjects request is invalid.',
        invalidIndexes: [1, -1, 2.5, '3'],
      })
    )

    const error = (await putGfsGrant({
      resourceId,
      permissions: ['read'],
      subjects: [{ type: 'user', id: '11111111-1111-1111-1111-111111111111' }],
    }).catch(caught => caught)) as GfsGrantError

    expect(error).toMatchObject({
      status: 400,
      code: 'subjects_invalid',
      serverMessage: 'The subjects request is invalid.',
      invalidIndexes: [1],
    })
    expect(error.message).toBe('400 subjects_invalid: The subjects request is invalid.')
  })

  it('does not duplicate a share error when message equals its machine code', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, {
        error: 'subjects_invalid',
        message: 'subjects_invalid',
        invalidIndexes: [0],
      })
    )

    const error = (await postGfsShare({
      resourceId,
      permissions: ['read'],
      subjects: [{ type: 'team', id: '22222222-2222-2222-2222-222222222222' }],
    }).catch(caught => caught)) as GfsGrantError

    expect(error).toMatchObject({
      status: 400,
      code: 'subjects_invalid',
      serverMessage: 'subjects_invalid',
      invalidIndexes: [0],
    })
    expect(error.message).toBe('400 subjects_invalid')
  })
})
