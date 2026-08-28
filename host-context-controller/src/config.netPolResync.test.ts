import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

const KNOBS = [
  'CONTEXT_MAPPER_NETPOL_RESYNC_SEC',
  'CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP',
  'CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT',
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

describe('NetworkPolicy resync and orphan-sweep config (#478)', () => {
  it('defaults resync to 0 and caps to 10/20 when unset', async () => {
    const { config } = await loadConfig({})
    expect(config.netPolResyncIntervalSec).toBe(0)
    expect(config.netPolOrphanDeleteCap).toBe(10)
    expect(config.netPolOrphanDeleteCapPercent).toBe(20)
  })

  it('keeps periodic resync disabled when the interval is 0', async () => {
    const { config } = await loadConfig({ CONTEXT_MAPPER_NETPOL_RESYNC_SEC: '0' })
    expect(config.netPolResyncIntervalSec).toBe(0)
  })

  it('accepts an explicit resync interval and cap overrides', async () => {
    const { config } = await loadConfig({
      CONTEXT_MAPPER_NETPOL_RESYNC_SEC: '300',
      CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP: '8',
      CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT: '25',
    })
    expect(config.netPolResyncIntervalSec).toBe(300)
    expect(config.netPolOrphanDeleteCap).toBe(8)
    expect(config.netPolOrphanDeleteCapPercent).toBe(25)
  })

  it('accepts an explicit 0 absolute cap (refuse any orphan delete)', async () => {
    const { config } = await loadConfig({ CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP: '0' })
    expect(config.netPolOrphanDeleteCap).toBe(0)
  })

  it('fails loud when the absolute orphan-delete cap is negative', async () => {
    await expect(loadConfig({ CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP: '-1' })).rejects.toThrow(
      /CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP/
    )
  })

  it('fails loud when the percent orphan-delete cap is negative', async () => {
    await expect(
      loadConfig({ CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT: '-1' })
    ).rejects.toThrow(/CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT/)
  })

  it.each(['2e1', '10.9', '12abc', '0x1F'] as const)(
    'fails loud when the absolute orphan-delete cap is non-canonical (%s)',
    async raw => {
      await expect(loadConfig({ CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP: raw })).rejects.toThrow(
        /CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP/
      )
    }
  )

  it.each(['2e1', '10.9', '12abc'] as const)(
    'fails loud when the percent orphan-delete cap is non-canonical (%s)',
    async raw => {
      await expect(
        loadConfig({ CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT: raw })
      ).rejects.toThrow(/CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT/)
    }
  )

  it.each(['25m', '1e3', '-5', '0.5', '2e1', 'abc'] as const)(
    'fails loud when the resync interval is non-canonical (%s)',
    async raw => {
      await expect(loadConfig({ CONTEXT_MAPPER_NETPOL_RESYNC_SEC: raw })).rejects.toThrow(
        /CONTEXT_MAPPER_NETPOL_RESYNC_SEC/
      )
    }
  )
})
