// control-api/test/services.orgApiKeyClient.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { cfg, log } = vi.hoisted(() => ({
  cfg: { registryUrl: 'https://registry.test' },
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('../src/config.js', () => ({ config: cfg }))
vi.mock('../src/observability/logger.js', () => ({ rootLogger: log }))
vi.mock('../src/services/registryVoucher.js', () => ({
  mintIdentityVoucher: vi.fn(() => 'voucher-jwt'),
}))

import {
  RegistryStatusError,
  __resetUserTokenCacheForTests,
  createKey,
  listKeys,
  revokeKey,
} from '../src/services/orgApiKeyClient.js'

const admin = { id: 'admin-1', username: 'alice' } as never

function makeRes(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  __resetUserTokenCacheForTests()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  log.error.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('orgApiKeyClient', () => {
  it('exchanges a voucher once and caches the user token across calls', async () => {
    fetchMock
      .mockResolvedValueOnce(makeRes(200, { token: 'user-tok' })) // /user/exchange
      .mockResolvedValueOnce(makeRes(200, { keys: [] })) // GET keys #1
      .mockResolvedValueOnce(makeRes(200, { keys: [] })) // GET keys #2 (no re-exchange)
    await listKeys(admin, 'acme')
    await listKeys(admin, 'acme')
    const exchangeCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/user/exchange'))
    expect(exchangeCalls).toHaveLength(1)
    // second key request carries the cached bearer
    const lastInit = fetchMock.mock.calls.at(-1)![1] as RequestInit
    expect((lastInit.headers as Record<string, string>).Authorization).toBe('Bearer user-tok')
  })

  it('on a gated-endpoint 401, evicts + re-exchanges once then retries', async () => {
    fetchMock
      .mockResolvedValueOnce(makeRes(200, { token: 'tok-1' })) // exchange #1
      .mockResolvedValueOnce(makeRes(401)) // GET keys → stale token
      .mockResolvedValueOnce(makeRes(200, { token: 'tok-2' })) // re-exchange
      .mockResolvedValueOnce(makeRes(200, { keys: [{ id: 'k1' }] })) // retry OK
    const out = await listKeys(admin, 'acme')
    expect(out.keys).toHaveLength(1)
  })

  it('maps a persistent gated 401 to a 502 RegistryStatusError (never a bare 401)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeRes(200, { token: 'tok-1' }))
      .mockResolvedValueOnce(makeRes(401)) // first gated 401
      .mockResolvedValueOnce(makeRes(200, { token: 'tok-2' }))
      .mockResolvedValueOnce(makeRes(401)) // still 401 after re-exchange
    await expect(listKeys(admin, 'acme')).rejects.toMatchObject({
      status: 502,
      message: 'registry_integration_error',
    })
  })

  it('logs registry_voucher_rejected and 502s when /user/exchange returns 401', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(401)) // exchange rejected
    await expect(listKeys(admin, 'acme')).rejects.toMatchObject({ status: 502 })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'registry_voucher_rejected' }),
      expect.any(String)
    )
  })

  it('logs registry_exchange_failed (status + code) and 502s on a non-401 exchange error', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(409, { error: 'reserved_username' })) // exchange create failed
    await expect(listKeys(admin, 'acme')).rejects.toMatchObject({
      status: 502,
      message: 'registry_integration_error',
    })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'registry_exchange_failed', status: 409, code: 'reserved_username' }),
      expect.any(String)
    )
  })

  it('forwards a registry error as a bare-code RegistryStatusError (no raw body)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeRes(200, { token: 'tok' }))
      .mockResolvedValueOnce(makeRes(403, { error: 'forbidden', extra: 'leak-me' }))
    const err = await listKeys(admin, 'acme').catch(e => e)
    expect(err).toBeInstanceOf(RegistryStatusError)
    expect(err.status).toBe(403)
    expect(err.message).toBe('forbidden') // bare code, not the raw body
    expect(JSON.stringify(err)).not.toContain('leak-me')
  })

  it('createKey returns the one-time key payload verbatim', async () => {
    fetchMock
      .mockResolvedValueOnce(makeRes(200, { token: 'tok' }))
      .mockResolvedValueOnce(
        makeRes(201, { id: 'k1', key: 'efrk_secret', key_prefix: 'efrk_sec', scopes: [], expires_at: null })
      )
    const out = await createKey(admin, 'acme', { description: 'ci' })
    expect(out.key).toBe('efrk_secret')
  })

  it('revokeKey resolves on 204', async () => {
    fetchMock
      .mockResolvedValueOnce(makeRes(200, { token: 'tok' }))
      .mockResolvedValueOnce(makeRes(204))
    await expect(revokeKey(admin, 'acme', 'k1')).resolves.toBeUndefined()
  })
})
