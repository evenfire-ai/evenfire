/**
 * Per-run caps on how many models the catalog sync may insert enabled. Both are
 * refused at boot unless they are canonical integers between 1 and 1000: a cap
 * of 0 would be an off-switch (the per-provider policy toggle is the only one),
 * and a cap with no ceiling would let one run push the allowlist ConfigMap past
 * its size limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const PER_PROVIDER = 'LLM_CATALOG_AUTO_ENABLE_MAX_PER_PROVIDER_PER_RUN'
const PER_RUN = 'LLM_CATALOG_AUTO_ENABLE_MAX_PER_RUN'
const KEYS = [PER_PROVIDER, PER_RUN] as const

async function loadConfigWith(env: Partial<Record<(typeof KEYS)[number], string>>) {
  const original = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  for (const key of KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of KEYS) {
      const value = original[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api llm catalog auto-enable caps config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to 100 per provider and 300 per run', async () => {
    const config = await loadConfigWith({})
    expect(config.llmCatalogAutoEnableMaxPerProviderPerRun).toBe(100)
    expect(config.llmCatalogAutoEnableMaxPerRun).toBe(300)
  })

  it('accepts overrides down to 1, independently (the global cap may be below the per-provider one)', async () => {
    const config = await loadConfigWith({ [PER_PROVIDER]: '50', [PER_RUN]: '1' })
    expect(config.llmCatalogAutoEnableMaxPerProviderPerRun).toBe(50)
    expect(config.llmCatalogAutoEnableMaxPerRun).toBe(1)
  })

  it('accepts the ceiling of 1000 for both', async () => {
    const config = await loadConfigWith({ [PER_PROVIDER]: '1000', [PER_RUN]: '1000' })
    expect(config.llmCatalogAutoEnableMaxPerProviderPerRun).toBe(1000)
    expect(config.llmCatalogAutoEnableMaxPerRun).toBe(1000)
  })

  for (const key of KEYS) {
    for (const over of ['1001', '1000000']) {
      it(`rejects ${key}=${over} above the ceiling at boot`, async () => {
        await expect(loadConfigWith({ [key]: over })).rejects.toThrow(
          `${key} must be an integer between 1 and 1000`
        )
      })
    }
    for (const bad of ['0', '-1', '1.5', 'abc', '0x10', ' 10']) {
      it(`rejects ${key}=${JSON.stringify(bad)} at boot`, async () => {
        await expect(loadConfigWith({ [key]: bad })).rejects.toThrow(
          `${key} must be a positive integer`
        )
      })
    }
  }

  it('no longer carries an auto-enable switch', async () => {
    const config = await loadConfigWith({})
    expect('llmCatalogAutoEnableEnabled' in config).toBe(false)
  })
})
