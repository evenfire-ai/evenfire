import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV = 'GFS_WATCH_HEARTBEAT_MS'
const previous = process.env[ENV]
const OUT_OF_RANGE_EVENT = 'env_value_out_of_range'

async function heartbeatWith(value: string | undefined) {
  if (value === undefined) delete process.env[ENV]
  else process.env[ENV] = value
  vi.resetModules()
  // Attach after the reset to the same logger instance the fresh config imports.
  const { rootLogger } = await import('../src/observability/logger.js')
  const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined)
  const { config } = await import('../src/config.js')
  const warnings = warn.mock.calls.filter(
    ([fields]) =>
      typeof fields === 'object' &&
      fields !== null &&
      (fields as { event?: unknown }).event === OUT_OF_RANGE_EVENT
  )
  return { heartbeatMs: config.gfsWatchHeartbeatMs, warnings }
}

describe('GFS_WATCH_HEARTBEAT_MS', () => {
  afterEach(() => {
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('defaults to 20 s without a warning', async () => {
    expect(await heartbeatWith(undefined)).toEqual({ heartbeatMs: 20_000, warnings: [] })
    expect(await heartbeatWith('')).toEqual({ heartbeatMs: 20_000, warnings: [] })
  })

  it('accepts the bounds the desktop validates in ready, [5 s, 25 s], without a warning', async () => {
    expect(await heartbeatWith('5000')).toEqual({ heartbeatMs: 5_000, warnings: [] })
    expect(await heartbeatWith('25000')).toEqual({ heartbeatMs: 25_000, warnings: [] })
  })

  it('falls back to the default outside them, unlike the 60 s entity-change ceiling, and warns', async () => {
    for (const value of ['4999', '25001', '60000', 'fast']) {
      expect(await heartbeatWith(value)).toEqual({
        heartbeatMs: 20_000,
        warnings: [
          [
            {
              event: OUT_OF_RANGE_EVENT,
              env: ENV,
              value,
              min: 5_000,
              max: 25_000,
              default: 20_000,
            },
            `${ENV} is outside [5000, 25000] or not an integer; using the default`,
          ],
        ],
      })
    }
  })
})
