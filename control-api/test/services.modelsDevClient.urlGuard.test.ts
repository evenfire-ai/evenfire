/**
 * Egress guard for the (env-overridable) models.dev catalog URL: the resolved
 * URL must be https:// and not a link-local/metadata host, validated BEFORE any
 * fetch. `MODELS_DEV_API_URL` is resolved at module import, so each case sets the
 * env and re-imports fresh.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV = 'MODELS_DEV_API_URL'

afterEach(() => {
  delete process.env[ENV]
  vi.resetModules()
})

async function loadWith(url: string | undefined) {
  vi.resetModules()
  if (url === undefined) delete process.env[ENV]
  else process.env[ENV] = url
  return import('../src/services/modelsDevClient.js')
}

describe('models.dev catalog URL egress guard', () => {
  it('rejects an http:// override and never fetches', async () => {
    const { loadModelsDevCatalog } = await loadWith('http://models.dev/api.json')
    const fetchImpl = vi.fn()
    await expect(loadModelsDevCatalog({ fetchImpl: fetchImpl as never })).rejects.toThrow(
      /https:\/\//
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a link-local / cloud-metadata host and never fetches', async () => {
    const { loadModelsDevCatalog } = await loadWith('https://169.254.169.254/latest/meta-data')
    const fetchImpl = vi.fn()
    await expect(loadModelsDevCatalog({ fetchImpl: fetchImpl as never })).rejects.toThrow(
      /egress|host/i
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a `.internal` cluster host and never fetches', async () => {
    const { loadModelsDevCatalog } = await loadWith('https://catalog.svc.cluster.internal/api.json')
    const fetchImpl = vi.fn()
    await expect(loadModelsDevCatalog({ fetchImpl: fetchImpl as never })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Regression (R1-M1): before the fix the guard blocked only by exact-string
  // match, so these internal targets slipped through the string checks and were
  // let out to fetch. They must now THROW before any fetch (T4: assert the
  // observable outcome — the guard rejects and the network is never touched).
  it.each([
    ['loopback 127.0.0.1', 'https://127.0.0.1/api.json'],
    ['loopback range 127.5.5.5', 'https://127.5.5.5/api.json'],
    ['unspecified 0.0.0.0', 'https://0.0.0.0/api.json'],
    ['RFC1918 10/8', 'https://10.0.0.5/api.json'],
    ['RFC1918 172.16/12', 'https://172.16.9.9/api.json'],
    ['RFC1918 192.168/16', 'https://192.168.1.1/api.json'],
    ['IPv6 loopback [::1]', 'https://[::1]/api.json'],
    ['IPv4-mapped [::ffff:127.0.0.1]', 'https://[::ffff:127.0.0.1]/api.json'],
    ['bare service name', 'https://kubernetes/api.json'],
    ['.svc cluster Service', 'https://kube-apiserver.default.svc/api.json'],
  ])('rejects internal target (%s) and never fetches', async (_label, url) => {
    const { loadModelsDevCatalog } = await loadWith(url)
    const fetchImpl = vi.fn()
    await expect(loadModelsDevCatalog({ fetchImpl: fetchImpl as never })).rejects.toThrow(
      /egress|host/i
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes the guard for the default https host (fetch IS attempted)', async () => {
    const { loadModelsDevCatalog } = await loadWith(undefined) // default https://models.dev/api.json
    // A throwing fetch proves the guard let us THROUGH to the network; the loader
    // then degrades to the vendored snapshot (its documented fetch-failure path).
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const res = await loadModelsDevCatalog({ fetchImpl: fetchImpl as never })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(res.source).toBe('vendored')
  })
})
