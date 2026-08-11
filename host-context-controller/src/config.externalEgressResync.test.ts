import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

const KNOBS = [
  'HCC_EXTERNAL_EGRESS_RESYNC_SEC',
  'HCC_EXTERNAL_EGRESS_OVERLAP_SEC',
  'HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC',
  'HCC_EXTERNAL_EGRESS_MAX_ENTRIES',
] as const

async function loadConfig(overrides: Partial<Record<(typeof KNOBS)[number], string>>) {
  vi.resetModules()
  process.env = { ...originalEnv }
  for (const k of KNOBS) delete process.env[k]
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('external egress sliding-window config (issue #299)', () => {
  it('applies plan defaults: interval below overlap, floor 5, cap 128', async () => {
    const { config } = await loadConfig({})
    // Default resync MUST sit below the overlap so entries never expire between
    // refreshes (the #299 gap). It is lowered from the legacy 300 to 60.
    expect(config.externalEgressResyncIntervalSec).toBe(60)
    expect(config.externalEgressOverlapSec).toBe(300)
    expect(config.externalEgressRefreshFloorSec).toBe(5)
    expect(config.externalEgressMaxEntries).toBe(128)
  })

  it('accepts a valid floor <= interval < overlap triple', async () => {
    const { config } = await loadConfig({
      HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC: '10',
      HCC_EXTERNAL_EGRESS_RESYNC_SEC: '30',
      HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '120',
    })
    expect(config.externalEgressRefreshFloorSec).toBe(10)
    expect(config.externalEgressResyncIntervalSec).toBe(30)
    expect(config.externalEgressOverlapSec).toBe(120)
  })

  it('fails loud when the refresh interval is NOT below the overlap', async () => {
    await expect(
      loadConfig({
        HCC_EXTERNAL_EGRESS_RESYNC_SEC: '300',
        HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '300',
      })
    ).rejects.toThrow(/overlap/i)
  })

  it('fails loud when the floor exceeds the interval', async () => {
    await expect(
      loadConfig({
        HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC: '100',
        HCC_EXTERNAL_EGRESS_RESYNC_SEC: '60',
      })
    ).rejects.toThrow(/floor/i)
  })

  it('fails loud when the interval exceeds HALF the overlap (audit L2 — grace weakening)', async () => {
    // interval 200 with overlap 300: 200 <= 300 (old rule) but 200 > 150 (overlap/2)
    // → the persisted window can lapse between refreshes.
    await expect(
      loadConfig({
        HCC_EXTERNAL_EGRESS_RESYNC_SEC: '200',
        HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '300',
      })
    ).rejects.toThrow(/half the overlap/i)
  })

  it('accepts interval == overlap/2 exactly', async () => {
    const { config } = await loadConfig({
      HCC_EXTERNAL_EGRESS_RESYNC_SEC: '150',
      HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '300',
    })
    expect(config.externalEgressResyncIntervalSec).toBe(150)
  })

  it('allows interval 0 (periodic resync disabled) without tripping the invariant', async () => {
    const { config } = await loadConfig({ HCC_EXTERNAL_EGRESS_RESYNC_SEC: '0' })
    expect(config.externalEgressResyncIntervalSec).toBe(0)
  })

  it('fails loud on a NEGATIVE interval instead of silently disabling resync (audit F4)', async () => {
    // A typo like -60 would silently reinstate the #299 drift bug (resync off).
    await expect(loadConfig({ HCC_EXTERNAL_EGRESS_RESYNC_SEC: '-60' })).rejects.toThrow(
      /HCC_EXTERNAL_EGRESS_RESYNC_SEC/
    )
  })
})
