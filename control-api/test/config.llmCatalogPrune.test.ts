/**
 * The catalog prune's grace and per-run cap. The grace is refused below one
 * hour (it could not absorb an id that flickers out of the catalog for a single
 * run) and the cap outside 1–1000, at boot rather than clamped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const GRACE = 'LLM_CATALOG_PRUNE_STALE_GRACE_MS'
const CAP = 'LLM_CATALOG_PRUNE_MAX_PER_RUN'
const KEYS = [GRACE, CAP] as const

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

describe('control-api llm catalog prune config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to a 7-day grace and 50 disables per run', async () => {
    const config = await loadConfigWith({})
    expect(config.llmCatalogPruneStaleGraceMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(config.llmCatalogPruneMaxPerRun).toBe(50)
  })

  it('accepts a one-hour grace and the cap bounds', async () => {
    expect((await loadConfigWith({ [GRACE]: '3600000' })).llmCatalogPruneStaleGraceMs).toBe(
      3_600_000
    )
    expect((await loadConfigWith({ [CAP]: '1' })).llmCatalogPruneMaxPerRun).toBe(1)
    expect((await loadConfigWith({ [CAP]: '1000' })).llmCatalogPruneMaxPerRun).toBe(1000)
  })

  it('refuses a grace below one hour at boot', async () => {
    await expect(loadConfigWith({ [GRACE]: '3599999' })).rejects.toThrow(
      `${GRACE} must be an integer >= 3600000 (milliseconds)`
    )
  })

  for (const value of ['0', '1001', 'abc']) {
    it(`refuses ${CAP}=${value} at boot`, async () => {
      await expect(loadConfigWith({ [CAP]: value })).rejects.toThrow(CAP)
    })
  }
})
