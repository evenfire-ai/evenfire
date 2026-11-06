/**
 * MODELS_DEV_API_URL is refused at boot by the same rule the catalog loader
 * applies before every fetch, so a misconfigured URL stops the process instead
 * of feeding a boot sync that retries forever. The documented emergency brake
 * (a host under `.invalid`) must still boot and load the vendored snapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV = 'MODELS_DEV_API_URL'
const BRAKE = 'https://models.dev.invalid/api.json'

async function bootWith(url: string | undefined) {
  vi.resetModules()
  if (url === undefined) delete process.env[ENV]
  else process.env[ENV] = url
  return (await import('../src/config.js')).config
}

afterEach(() => {
  delete process.env[ENV]
  vi.resetModules()
})

describe('MODELS_DEV_API_URL at boot', () => {
  it('boots with the default public catalog', async () => {
    await expect(bootWith(undefined)).resolves.toBeDefined()
  })

  it.each([
    ['http://models.dev/api.json', /https:\/\//],
    ['https://169.254.169.254/latest/meta-data', /egress target/],
    ['https://127.0.0.1/api.json', /egress target/],
    ['https://catalog.svc.cluster.local/api.json', /egress target/],
    ['https://kubernetes/api.json', /egress target/],
    ['not a url', /not a valid URL/],
  ])('refuses %s', async (url, message) => {
    await expect(bootWith(url)).rejects.toThrow(message)
  })

  it('boots with the emergency brake, and the loader then falls back to the vendored snapshot', async () => {
    await expect(bootWith(BRAKE)).resolves.toBeDefined()
    const { loadModelsDevCatalog } = await import('../src/services/modelsDevClient.js')
    // The real fetch: `.invalid` never resolves.
    const result = await loadModelsDevCatalog()
    expect(result.source).toBe('vendored')
  }, 20_000)
})
