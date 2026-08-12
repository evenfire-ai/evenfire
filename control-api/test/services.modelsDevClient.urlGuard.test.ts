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
