import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthExpiredError,
  createRegistryApiKey,
  listRegistryApiKeys,
  revokeRegistryApiKey,
  setGlobalAuthErrorHandler,
} from '../api'

function makeRes(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('registry keys api', () => {
  it('listRegistryApiKeys returns { org, keys }', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(200, { org: 'acme', keys: [] }))
    await expect(listRegistryApiKeys()).resolves.toEqual({ org: 'acme', keys: [] })
  })

  it('attaches .status and .code from the error body', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(409, { error: 'too_many_keys' }))
    const err = await createRegistryApiKey({}).catch(e => e)
    expect(err.status).toBe(409)
    expect(err.code).toBe('too_many_keys')
  })

  it('attaches .org from a 403 forbidden body', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(403, { error: 'forbidden', org: 'acme' }))
    const err = await listRegistryApiKeys().catch(e => e)
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
    expect(err.org).toBe('acme')
  })

  it('revoke resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(204))
    await expect(revokeRegistryApiKey('k1')).resolves.toBeUndefined()
  })

  it('a 401 response triggers the global auth handler and rejects with AuthExpiredError', async () => {
    const handler = vi.fn()
    setGlobalAuthErrorHandler(handler)
    fetchMock.mockResolvedValueOnce(makeRes(401))
    const err = await listRegistryApiKeys().catch(e => e)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(AuthExpiredError)
    // Clean up global handler so it does not leak into other tests
    setGlobalAuthErrorHandler(() => {})
  })
})
