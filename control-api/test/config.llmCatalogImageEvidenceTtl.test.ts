/**
 * Validity window for image-input evidence derived from models.dev (#654).
 *
 * The TTL is not cosmetic: it is counted from the catalog CAPTURE time, and once
 * it lapses the shared contract resolves the row to `unknown` with reason
 * `evidence_expired` and images are refused. A TTL shorter than two sync
 * intervals therefore expires evidence the cron cannot possibly have renewed
 * yet — the feature would fail on its own schedule, with no external cause.
 * That cross-field rule only applies when the cron is the thing doing the
 * refreshing, so it is asserted here in both directions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const TTL = 'LLM_CATALOG_IMAGE_EVIDENCE_TTL_MS'
const INTERVAL = 'LLM_CATALOG_SYNC_INTERVAL_MS'
const CRON = 'LLM_CATALOG_SYNC_CRON_ENABLED'
const KEYS = [TTL, INTERVAL, CRON] as const

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

describe('control-api llm catalog image-evidence TTL config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to 30 days when unset', async () => {
    const config = await loadConfigWith({})
    expect(config.llmCatalogImageEvidenceTtlMs).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('accepts an override at or above the floor', async () => {
    const config = await loadConfigWith({ [TTL]: '120000' })
    expect(config.llmCatalogImageEvidenceTtlMs).toBe(120_000)
  })

  it('rejects a TTL below the floor', async () => {
    await expect(loadConfigWith({ [TTL]: '1000' })).rejects.toThrow(/must be an integer >= 120000/)
  })

  it('rejects a TTL shorter than twice the cron interval when the cron is enabled', async () => {
    await expect(
      loadConfigWith({ [CRON]: 'true', [INTERVAL]: '86400000', [TTL]: '100000000' })
    ).rejects.toThrow(
      'LLM_CATALOG_IMAGE_EVIDENCE_TTL_MS must be at least twice LLM_CATALOG_SYNC_INTERVAL_MS when LLM_CATALOG_SYNC_CRON_ENABLED=true'
    )
  })

  it('accepts the same TTL when the cron is off (the guard is conditional)', async () => {
    // Witness that the throw above came from the cross-field guard and not from
    // the floor: identical TTL and interval, only the flag differs.
    const config = await loadConfigWith({ [INTERVAL]: '86400000', [TTL]: '100000000' })
    expect(config.llmCatalogImageEvidenceTtlMs).toBe(100_000_000)
    expect(config.llmCatalogSyncCronEnabled).toBe(false)
  })
})
