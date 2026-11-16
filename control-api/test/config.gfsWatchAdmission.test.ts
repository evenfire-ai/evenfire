import { afterEach, describe, expect, it, vi } from 'vitest'

const ENVS = ['GFS_WATCH_MAX_CONNECTIONS', 'GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL'] as const
const previous = Object.fromEntries(ENVS.map(name => [name, process.env[name]]))

async function capsWith(env: Partial<Record<(typeof ENVS)[number], string>>) {
  for (const name of ENVS) {
    const value = env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.resetModules()
  const { config } = await import('../src/config.js')
  return {
    process: config.gfsWatchMaxConnections,
    perPrincipal: config.gfsWatchMaxConnectionsPerPrincipal,
  }
}

describe('GFS_WATCH_MAX_CONNECTIONS and GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL', () => {
  afterEach(() => {
    for (const name of ENVS) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    vi.resetModules()
  })

  it('default to the registry caps when unset', async () => {
    expect(await capsWith({})).toEqual({ process: 256, perPrincipal: 8 })
    const limits = await import('../src/services/gfsWatch/admissionLimits.js')
    expect(await capsWith({})).toEqual({
      process: limits.GFS_WATCH_MAX_CONNECTIONS,
      perPrincipal: limits.GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL,
    })
  })

  it('accept an override within [1, 10000] and [1, 64]', async () => {
    expect(
      await capsWith({
        GFS_WATCH_MAX_CONNECTIONS: '1',
        GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: '1',
      })
    ).toEqual({ process: 1, perPrincipal: 1 })
    expect(
      await capsWith({
        GFS_WATCH_MAX_CONNECTIONS: '10000',
        GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: '64',
      })
    ).toEqual({ process: 10_000, perPrincipal: 64 })
  })

  it('fall back to the default outside the bounds or when not an integer', async () => {
    for (const [proc, per] of [
      ['0', '0'],
      ['10001', '65'],
      ['-5', '-1'],
      ['12.5', '2.5'],
      ['many', 'NaN'],
      ['', ''],
    ]) {
      expect(
        await capsWith({
          GFS_WATCH_MAX_CONNECTIONS: proc,
          GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: per,
        })
      ).toEqual({ process: 256, perPrincipal: 8 })
    }
  })
})
