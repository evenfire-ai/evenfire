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

  it('accepts a valid floor <= interval <= overlap/2 triple', async () => {
    const { config } = await loadConfig({
      HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC: '10',
      HCC_EXTERNAL_EGRESS_RESYNC_SEC: '30',
      HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '120',
    })
    expect(config.externalEgressRefreshFloorSec).toBe(10)
    expect(config.externalEgressResyncIntervalSec).toBe(30)
    expect(config.externalEgressOverlapSec).toBe(120)
  })

  it('fails loud when the refresh interval exceeds half the overlap', async () => {
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

  // M-C prong 1: cadence knobs must be capped at 3600s. An unbounded value like
  // 2_200_000 exceeds Node's signed-32-bit setTimeout limit (2^31-1 ms) and is
  // clamped to 1ms → a back-to-back DNS-resync hot loop. Port of commit 3f968956.
  it('fails loud when the overlap exceeds the 3600s cap (M-C timer overflow)', async () => {
    await expect(loadConfig({ HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '3601' })).rejects.toThrow(/3600/)
  })

  it('fails loud when the resync interval exceeds the 3600s cap (M-C timer overflow)', async () => {
    await expect(
      loadConfig({
        HCC_EXTERNAL_EGRESS_RESYNC_SEC: '3601',
        HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '3600',
      })
    ).rejects.toThrow(/3600/)
  })

  it('accepts the cadence knobs exactly at the 3600s cap', async () => {
    const { config } = await loadConfig({
      HCC_EXTERNAL_EGRESS_RESYNC_SEC: '1800',
      HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '3600',
    })
    expect(config.externalEgressOverlapSec).toBe(3600)
    expect(config.externalEgressResyncIntervalSec).toBe(1800)
  })

  // R1-M5: the ceiling is 1300 (aligned with WRC); the core's byte-aware
  // eviction is the real annotation-size bound, not this count.
  it('fails loud when max entries exceed the 1300 cap (R1-M5, aligned with WRC)', async () => {
    await expect(loadConfig({ HCC_EXTERNAL_EGRESS_MAX_ENTRIES: '1301' })).rejects.toThrow(/1300/)
  })

  it('accepts max entries exactly at the 1300 cap', async () => {
    const { config } = await loadConfig({ HCC_EXTERNAL_EGRESS_MAX_ENTRIES: '1300' })
    expect(config.externalEgressMaxEntries).toBe(1300)
  })

  // R1-L1: the four knobs use a LOUD parser that rejects non-canonical values,
  // not parseInt (which silently coerces '60.5'->60 / '60abc'->60 and lets an
  // in-range typo slip past the range invariant).
  it('R1-L1: fails loud on a non-integer knob value instead of silently coercing', async () => {
    await expect(loadConfig({ HCC_EXTERNAL_EGRESS_RESYNC_SEC: '60.5' })).rejects.toThrow(
      /HCC_EXTERNAL_EGRESS_RESYNC_SEC/
    )
    await expect(loadConfig({ HCC_EXTERNAL_EGRESS_OVERLAP_SEC: '300abc' })).rejects.toThrow(
      /HCC_EXTERNAL_EGRESS_OVERLAP_SEC/
    )
  })
})
