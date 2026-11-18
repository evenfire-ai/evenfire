import { afterEach, describe, expect, it, vi } from 'vitest'

const ENVS = ['GFS_WATCH_MAX_CONNECTIONS', 'GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL'] as const
const previous = Object.fromEntries(ENVS.map(name => [name, process.env[name]]))
const OUT_OF_RANGE_EVENT = 'env_value_out_of_range'

async function capsWith(env: Partial<Record<(typeof ENVS)[number], string>>) {
  for (const name of ENVS) {
    const value = env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.resetModules()
  // Attach after the reset to the same logger instance the fresh config imports.
  const { rootLogger } = await import('../src/observability/logger.js')
  const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined)
  const { config } = await import('../src/config.js')
  const warnings = warn.mock.calls
    .map(([fields]) => fields)
    .filter(
      (fields): fields is Record<string, unknown> =>
        typeof fields === 'object' &&
        fields !== null &&
        (fields as { event?: unknown }).event === OUT_OF_RANGE_EVENT
    )
  return {
    process: config.gfsWatchMaxConnections,
    perPrincipal: config.gfsWatchMaxConnectionsPerPrincipal,
    warnings,
  }
}

describe('GFS_WATCH_MAX_CONNECTIONS and GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL', () => {
  afterEach(() => {
    for (const name of ENVS) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('default to the registry caps when unset or blank, without a warning', async () => {
    expect(await capsWith({})).toEqual({ process: 256, perPrincipal: 8, warnings: [] })
    expect(
      await capsWith({ GFS_WATCH_MAX_CONNECTIONS: '', GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: '' })
    ).toEqual({ process: 256, perPrincipal: 8, warnings: [] })
    const limits = await import('../src/services/gfsWatch/admissionLimits.js')
    expect(await capsWith({})).toEqual({
      process: limits.GFS_WATCH_MAX_CONNECTIONS,
      perPrincipal: limits.GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL,
      warnings: [],
    })
  })

  it('accept an override within [1, 10000] and [1, 64] without a warning', async () => {
    expect(
      await capsWith({
        GFS_WATCH_MAX_CONNECTIONS: '1',
        GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: '1',
      })
    ).toEqual({ process: 1, perPrincipal: 1, warnings: [] })
    expect(
      await capsWith({
        GFS_WATCH_MAX_CONNECTIONS: '10000',
        GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: '64',
      })
    ).toEqual({ process: 10_000, perPrincipal: 64, warnings: [] })
  })

  it('fall back to the default outside the bounds or when not an integer, and warn per env', async () => {
    for (const [proc, per] of [
      ['0', '0'],
      ['10001', '65'],
      ['-5', '-1'],
      ['12.5', '2.5'],
      ['many', 'NaN'],
    ]) {
      expect(
        await capsWith({
          GFS_WATCH_MAX_CONNECTIONS: proc,
          GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: per,
        })
      ).toEqual({
        process: 256,
        perPrincipal: 8,
        warnings: [
          {
            event: OUT_OF_RANGE_EVENT,
            env: 'GFS_WATCH_MAX_CONNECTIONS',
            value: proc,
            min: 1,
            max: 10_000,
            default: 256,
          },
          {
            event: OUT_OF_RANGE_EVENT,
            env: 'GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL',
            value: per,
            min: 1,
            max: 64,
            default: 8,
          },
        ],
      })
    }
  })

  it('warns only for the env that is out of range', async () => {
    expect(
      await capsWith({
        GFS_WATCH_MAX_CONNECTIONS: '512',
        GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL: '65',
      })
    ).toEqual({
      process: 512,
      perPrincipal: 8,
      warnings: [
        {
          event: OUT_OF_RANGE_EVENT,
          env: 'GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL',
          value: '65',
          min: 1,
          max: 64,
          default: 8,
        },
      ],
    })
  })
})
