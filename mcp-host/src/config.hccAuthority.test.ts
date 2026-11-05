import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const originalEnv = process.env

async function loadAuthorityMaxStaleness(
  value: string | undefined,
  pollInterval = '30000'
): Promise<number> {
  vi.resetModules()
  process.env = { ...originalEnv }
  process.env.CLERUM_CONTEXT_MAPPER_POLL_INTERVAL = pollInterval
  if (value === undefined) {
    delete process.env.HCC_AUTHORITY_MAX_STALENESS_MS
  } else {
    process.env.HCC_AUTHORITY_MAX_STALENESS_MS = value
  }
  return (await import('./config')).config.hccAuthorityMaxStalenessMs
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

const RULE_TEXT =
  'must be at least poll interval + 2 × max(poll interval, inventory request timeout) + inventory request timeout + 1000ms scheduling allowance'

describe('HCC_AUTHORITY_MAX_STALENESS_MS', () => {
  it('defaults to the 180-second rollout-tolerant window', async () => {
    await expect(loadAuthorityMaxStaleness(undefined)).resolves.toBe(180_000)
  })

  it('allows an operator to fail closed sooner, down to the two-missed-poll floor', async () => {
    await expect(loadAuthorityMaxStaleness('36000', '5000')).resolves.toBe(36_000)
    await expect(loadAuthorityMaxStaleness('35999', '5000')).rejects.toThrow('= 36000ms')
  })

  it('allows an operator to raise the window for a slower-starting cluster (issue #425)', async () => {
    await expect(loadAuthorityMaxStaleness('300000')).resolves.toBe(300_000)
  })

  it('cannot be configured beyond the 600-second hard ceiling', async () => {
    await expect(loadAuthorityMaxStaleness('700000')).resolves.toBe(600_000)
  })

  it('uses the default window for an invalid value', async () => {
    await expect(loadAuthorityMaxStaleness('not-a-duration')).resolves.toBe(180_000)
  })
})

describe('validateHccAuthorityTiming (issue #1350)', () => {
  it('requires the bound to absorb two missed polls when the request timeout is below the interval', async () => {
    const { validateHccAuthorityTiming } = await import('./config')
    expect(() => validateHccAuthorityTiming(30_000, 100_999, 10_000)).toThrow(
      `HCC_AUTHORITY_MAX_STALENESS_MS (100999ms, effective after the 600000ms cap) ${RULE_TEXT} = 30000 + 60000 + 10000 + 1000 = 101000ms (CLERUM_CONTEXT_MAPPER_POLL_INTERVAL=30000ms, request timeout 10000ms), so that 2 missed HCC polls followed by an answer at the request timeout cannot revoke a healthy MCP fleet; refusing to start`
    )
    expect(() => validateHccAuthorityTiming(30_000, 101_000, 10_000)).not.toThrow()
  })

  it('spaces missed polls by the request timeout when it exceeds the interval', async () => {
    const { validateHccAuthorityTiming } = await import('./config')
    expect(() => validateHccAuthorityTiming(5_000, 35_999, 10_000)).toThrow(
      '= 5000 + 20000 + 10000 + 1000 = 36000ms'
    )
    expect(() => validateHccAuthorityTiming(5_000, 36_000, 10_000)).not.toThrow()
  })

  it('rejects the old 60-second minikube pin and the one-missed-poll floor', async () => {
    const { validateHccAuthorityTiming } = await import('./config')
    expect(() => validateHccAuthorityTiming(30_000, 60_000, 10_000)).toThrow('= 101000ms')
    expect(() => validateHccAuthorityTiming(30_000, 71_000, 10_000)).toThrow('= 101000ms')
  })

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['a negative value', -1],
    ['a fraction', 1.5],
    ['a value above Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s as the poll interval or the staleness bound', async (_label, invalid) => {
    const { validateHccAuthorityTiming } = await import('./config')
    expect(() => validateHccAuthorityTiming(invalid, 180_000, 10_000)).toThrow(
      `CLERUM_CONTEXT_MAPPER_POLL_INTERVAL (${invalid}ms) must be a positive safe integer number of milliseconds; refusing to start`
    )
    expect(() => validateHccAuthorityTiming(30_000, invalid, 10_000)).toThrow(
      `HCC_AUTHORITY_MAX_STALENESS_MS (${invalid}ms) must be a positive safe integer number of milliseconds; refusing to start`
    )
  })

  it('accepts the default 30-second poll inside the default staleness window', async () => {
    const { validateHccAuthorityTiming } = await import('./config')
    // Liveness witness: the same call rejects a bound one millisecond below the floor.
    expect(() => validateHccAuthorityTiming(30_000, 100_999, 10_000)).toThrow('= 101000ms')
    expect(() => validateHccAuthorityTiming(30_000, 180_000, 10_000)).not.toThrow()
  })
})

describe('module-load authority timing check (issue #1350)', () => {
  it('passes the shared request timeout and enforces the two-missed-poll floor at startup', async () => {
    await expect(loadAuthorityMaxStaleness('100999', '30000')).rejects.toThrow(
      `HCC_AUTHORITY_MAX_STALENESS_MS (100999ms, effective after the 600000ms cap) ${RULE_TEXT} = 30000 + 60000 + 10000 + 1000 = 101000ms`
    )
    await expect(loadAuthorityMaxStaleness('101000', '30000')).resolves.toBe(101_000)
    await expect(loadAuthorityMaxStaleness('180000', '30000')).resolves.toBe(180_000)
  })

  it('refuses to start with the old 60-second minikube pin', async () => {
    await expect(loadAuthorityMaxStaleness('60000', '30000')).rejects.toThrow(
      `HCC_AUTHORITY_MAX_STALENESS_MS (60000ms, effective after the 600000ms cap) ${RULE_TEXT} = 30000 + 60000 + 10000 + 1000 = 101000ms`
    )
  })

  it('refuses to start with a non-numeric poll interval', async () => {
    await expect(loadAuthorityMaxStaleness('180000', 'not-a-number')).rejects.toThrow(
      'CLERUM_CONTEXT_MAPPER_POLL_INTERVAL (NaNms) must be a positive safe integer number of milliseconds; refusing to start'
    )
  })
})

describe("the validator's T is the inventory poll's real timeout (#1338 L3)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('binds the startup floor to the timeout the inventory request actually arms', async () => {
    vi.resetModules()
    process.env = { ...originalEnv, CLERUM_CONTEXT_MAPPER_POLL_INTERVAL: '30000' }
    delete process.env.HCC_AUTHORITY_MAX_STALENESS_MS
    const { getContextMapperClient } = await import('./contextMapperClient')
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetchStub = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ servers: [], timestamp: '2026-11-05T00:00:00Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchStub)

    await getContextMapperClient({
      getAccessToken: () => 'fixture-access-token',
      refreshOnUnauthorized: async () => undefined,
      onCallerAuthorizationFailure: () => undefined,
    }).pollServers()

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(String(fetchStub.mock.calls[0]?.[0])).toMatch(/\/api\/v2\/hosts\/self\/mcpservers$/)
    expect(timeout).toHaveBeenCalledTimes(1)
    const requestTimeoutMs = timeout.mock.calls[0]?.[0]
    expect(Number.isSafeInteger(requestTimeoutMs) && (requestTimeoutMs as number) > 0).toBe(true)

    const interval = 30_000
    const minimum =
      interval +
      2 * Math.max(interval, requestTimeoutMs as number) +
      (requestTimeoutMs as number) +
      1_000
    await expect(loadAuthorityMaxStaleness(String(minimum - 1), String(interval))).rejects.toThrow(
      `= ${minimum}ms`
    )
    await expect(loadAuthorityMaxStaleness(String(minimum), String(interval))).resolves.toBe(
      minimum
    )
  })
})

describe('the poll-interval ceiling the docs state (#1338 L7)', () => {
  it('accepts a 56333 ms interval under the 180000 ms default and rejects 56334', async () => {
    const { validateHccAuthorityTiming, CONTEXT_MAPPER_REQUEST_TIMEOUT_MS } =
      await import('./config')
    expect(() =>
      validateHccAuthorityTiming(56_333, 180_000, CONTEXT_MAPPER_REQUEST_TIMEOUT_MS)
    ).not.toThrow()
    expect(() =>
      validateHccAuthorityTiming(56_334, 180_000, CONTEXT_MAPPER_REQUEST_TIMEOUT_MS)
    ).toThrow('refusing to start')
  })

  it('states the floor and both ceilings, computed from the source constants, in the docs', async () => {
    const {
      CONTEXT_MAPPER_REQUEST_TIMEOUT_MS: requestTimeout,
      HCC_AUTHORITY_SCHEDULING_ALLOWANCE_MS: allowance,
      HCC_AUTHORITY_MIN_TOLERATED_MISSED_POLLS: missedPolls,
      HCC_AUTHORITY_MAX_STALENESS_CEILING_MS: cap,
    } = await import('./config')
    const defaultInterval = 30_000
    const defaultBound = 180_000
    const floor =
      defaultInterval +
      missedPolls * Math.max(defaultInterval, requestTimeout) +
      requestTimeout +
      allowance
    // Ceilings for intervals of at least the request timeout.
    const ceiling = (bound: number) =>
      Math.floor((bound - requestTimeout - allowance) / (1 + missedPolls))
    const expected = [floor, ceiling(defaultBound), ceiling(cap)].map(String)
    expect(expected).toEqual(['101000', '56333', '196333'])

    for (const doc of [
      path.resolve(__dirname, '../../docs/deploy/releases-and-upgrades.md'),
      path.resolve(__dirname, '../README.md'),
    ]) {
      const text = readFileSync(doc, 'utf8')
      expect(text.length).toBeGreaterThan(0)
      for (const value of expected) expect(text, `${doc} states ${value}`).toContain(value)
    }
  })
})
