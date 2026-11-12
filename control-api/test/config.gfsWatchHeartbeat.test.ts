import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV = 'GFS_WATCH_HEARTBEAT_MS'
const previous = process.env[ENV]

async function heartbeatWith(value: string | undefined): Promise<number> {
  if (value === undefined) delete process.env[ENV]
  else process.env[ENV] = value
  vi.resetModules()
  const { config } = await import('../src/config.js')
  return config.gfsWatchHeartbeatMs
}

describe('GFS_WATCH_HEARTBEAT_MS', () => {
  afterEach(() => {
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
    vi.resetModules()
  })

  it('defaults to 20 s', async () => {
    expect(await heartbeatWith(undefined)).toBe(20_000)
  })

  it('accepts the bounds the desktop validates in ready, [5 s, 25 s]', async () => {
    expect(await heartbeatWith('5000')).toBe(5_000)
    expect(await heartbeatWith('25000')).toBe(25_000)
  })

  it('falls back to the default outside them, unlike the 60 s entity-change ceiling', async () => {
    expect(await heartbeatWith('4999')).toBe(20_000)
    expect(await heartbeatWith('25001')).toBe(20_000)
    expect(await heartbeatWith('60000')).toBe(20_000)
  })
})
