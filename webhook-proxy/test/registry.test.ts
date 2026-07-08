import { describe, expect, it, vi } from 'vitest'
import type { ProxyConfig } from '../src/config'
import { RegistryClient } from '../src/registry'
import type { RegistryHit } from '../src/types'

const baseConfig = (): ProxyConfig => ({
  httpPort: 0,
  metricsPort: 0,
  controlApiBaseUrl: 'http://control-api.test/api/v1',
  controlApiServiceToken: 't',
  sandboxNamespace: 'sandbox-recipes',
  registryCacheTtlMs: 50,
  upstreamTimeoutMs: 5000,
  maxBodyBytesCeiling: 10 * 1024 * 1024,
})

const HIT: RegistryHit = {
  exists: true,
  methods: ['POST'],
  maxBodyBytes: 1_048_576,
  gateway: { service: 'wf-r1-webhook-gateway', namespace: 'sandbox-recipes', port: 8090 },
}

describe('RegistryClient', () => {
  it('returns a hit on 200 and caches it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(HIT) })
    const client = new RegistryClient(baseConfig(), fetcher)
    const result = await client.lookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      webhookId: 'fireflies',
    })
    expect(result).toEqual(HIT)
    // Second lookup hits the cache.
    const result2 = await client.lookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      webhookId: 'fireflies',
    })
    expect(result2).toEqual(HIT)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('caches negative results (404 webhook_not_found)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 404,
      body: JSON.stringify({ exists: false, reason: 'webhook_not_found' }),
    })
    const client = new RegistryClient(baseConfig(), fetcher)
    const ids = { recipeNs: 'sandbox-recipes', recipeName: 'r1', webhookId: 'gone' }
    const a = await client.lookup(ids)
    const b = await client.lookup(ids)
    expect(a).toEqual({ exists: false, reason: 'webhook_not_found' })
    expect(b).toEqual({ exists: false, reason: 'webhook_not_found' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache upstream errors (transient)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, body: 'unavailable' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(HIT) })
    const client = new RegistryClient(baseConfig(), fetcher)
    const a = await client.lookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      webhookId: 'fireflies',
    })
    expect(a.exists).toBe(false)
    if (!a.exists && 'reason' in a) expect(a.reason).toBe('upstream_error')
    const b = await client.lookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      webhookId: 'fireflies',
    })
    expect(b).toEqual(HIT)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('expires cache after registryCacheTtlMs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(HIT) })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(HIT) })
    const client = new RegistryClient(baseConfig(), fetcher)
    const ids = { recipeNs: 'sandbox-recipes', recipeName: 'r1', webhookId: 'fireflies' }
    await client.lookup(ids)
    await new Promise(r => setTimeout(r, 60)) // > 50ms TTL
    await client.lookup(ids)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('passes the webhook-proxy service identity headers on every lookup', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ status: 200, body: JSON.stringify(HIT) })
    const client = new RegistryClient(baseConfig(), fetcher)
    await client.lookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      webhookId: 'fireflies',
    })
    const [_url, headers] = fetcher.mock.calls[0]
    expect(headers).toMatchObject({
      authorization: 'Bearer t',
      'x-service-token': 'webhook-proxy',
    })
  })

  it('handles 400 from control-api as invalid_request (proxy returns 400 to caller)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: 'invalid_recipe_name' }),
    })
    const client = new RegistryClient(baseConfig(), fetcher)
    const r = await client.lookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      webhookId: 'fireflies',
    })
    expect(r.exists).toBe(false)
    if (!r.exists && 'reason' in r) expect(r.reason).toBe('invalid_request')
  })
})
