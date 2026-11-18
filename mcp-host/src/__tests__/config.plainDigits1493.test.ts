import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMcpCatalogBootstrapConfig,
  parseDynamicToolsThreshold,
  parseStatelessHeartbeatIntervalMs,
} from '../config'

// #1493: unset or "" means the default; any other value must be plain decimal
// digits, or the Host refuses to start. Number() and parseInt() used to read
// the spellings below.
const REFUSED_SPELLINGS = (value: string) => [
  '   ',
  ` ${value} `,
  `+${value}`,
  `0${value}`,
  `${value}.0`,
  `${value}e0`,
  `0x${Number(value).toString(16)}`,
  `${value}.5`,
  `${value}abc`,
  '0',
  '-1',
  'abc',
]

describe('#1493 CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS', () => {
  it.each([undefined, ''])('means the default for %s', raw => {
    expect(parseStatelessHeartbeatIntervalMs(raw)).toBe(30_000)
  })

  it('accepts plain digits', () => {
    expect(parseStatelessHeartbeatIntervalMs('15000')).toBe(15_000)
  })

  it.each(REFUSED_SPELLINGS('15000'))("refuses '%s' and names the variable", raw => {
    expect(() => parseStatelessHeartbeatIntervalMs(raw)).toThrow(
      'CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS'
    )
  })
})

describe('#1493 CLERUM_DYNAMIC_TOOLS_THRESHOLD', () => {
  it.each([undefined, ''])('means the default for %s', raw => {
    expect(parseDynamicToolsThreshold(raw)).toBe(60)
  })

  it('accepts plain digits', () => {
    expect(parseDynamicToolsThreshold('40')).toBe(40)
  })

  // Before #1493: '0', negatives and text fell back to 60 with a warning,
  // '60abc' became 60 and '0x3c' fell back to the default.
  it.each(REFUSED_SPELLINGS('40'))("refuses '%s' and names the variable", raw => {
    expect(() => parseDynamicToolsThreshold(raw)).toThrow('CLERUM_DYNAMIC_TOOLS_THRESHOLD')
  })
})

const BOOTSTRAP: Array<[string, keyof ReturnType<typeof buildMcpCatalogBootstrapConfig>, number]> =
  [
    ['MCP_CATALOG_BOOTSTRAP_WAIT_BUDGET_MS', 'waitBudgetMs', 4000],
    ['MCP_CATALOG_BOOTSTRAP_PROBE_TIMEOUT_MS', 'probeTimeoutMs', 2000],
    ['MCP_CATALOG_BOOTSTRAP_CONNECT_TIMEOUT_MS', 'connectTimeoutMs', 8000],
    ['MCP_CATALOG_BOOTSTRAP_NEGATIVE_TTL_MS', 'negativeTtlMs', 15000],
    ['MCP_CATALOG_BOOTSTRAP_FAILURE_TTL_MS', 'failureTtlMs', 60000],
    ['MCP_CATALOG_BOOTSTRAP_PROBES_PER_MIN', 'probesPerMin', 20],
    ['MCP_CATALOG_BOOTSTRAP_BACKOFF_MS', 'backoffMs', 30000],
  ]

describe('#1493 MCP_CATALOG_BOOTSTRAP_* numbers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(BOOTSTRAP)('%s: "" means the default (it used to stop the Host)', (name, field, dflt) => {
    vi.stubEnv(name, '')
    expect(buildMcpCatalogBootstrapConfig()[field]).toBe(dflt)
  })

  it.each(BOOTSTRAP)('%s: a fraction stops the Host (it used to be accepted)', name => {
    vi.stubEnv(name, '1000.5')
    expect(() => buildMcpCatalogBootstrapConfig()).toThrow(name)
  })

  it.each(REFUSED_SPELLINGS('1000'))(
    "MCP_CATALOG_BOOTSTRAP_BACKOFF_MS: refuses '%s' and names the variable",
    raw => {
      vi.stubEnv('MCP_CATALOG_BOOTSTRAP_BACKOFF_MS', raw)
      expect(() => buildMcpCatalogBootstrapConfig()).toThrow('MCP_CATALOG_BOOTSTRAP_BACKOFF_MS')
    }
  )

  it('accepts plain digits in range', () => {
    vi.stubEnv('MCP_CATALOG_BOOTSTRAP_BACKOFF_MS', '1000')
    expect(buildMcpCatalogBootstrapConfig().backoffMs).toBe(1000)
  })
})

// R2-L1: a millisecond value that becomes a timer delay or an MCP request
// timeout must fit the Node timer range. Node fires a larger delay after
// about 1 ms, and an MCP request rejects a larger timeout.
describe('R2-L1 timer-range bound', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS accepts 2147483647', () => {
    expect(parseStatelessHeartbeatIntervalMs('2147483647')).toBe(2_147_483_647)
  })

  it.each(['2147483648', '9007199254740991'])(
    'CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS refuses %s and names the maximum',
    raw => {
      expect(() => parseStatelessHeartbeatIntervalMs(raw)).toThrow(
        /CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS='\d+' must be at most 2147483647/
      )
    }
  )

  // The message must name the bound: a probe timeout this large also fails
  // the probe-timeout-below-wait-budget check, whose message names the variable.
  it.each([
    'MCP_CATALOG_BOOTSTRAP_WAIT_BUDGET_MS',
    'MCP_CATALOG_BOOTSTRAP_PROBE_TIMEOUT_MS',
    'MCP_CATALOG_BOOTSTRAP_CONNECT_TIMEOUT_MS',
  ])('%s refuses 2147483648 and names the maximum', name => {
    vi.stubEnv(name, '2147483648')
    expect(() => buildMcpCatalogBootstrapConfig()).toThrow(
      new RegExp(`${name} must be at most 2147483647`)
    )
  })

  it.each([
    ['MCP_CATALOG_BOOTSTRAP_WAIT_BUDGET_MS', 'waitBudgetMs'],
    ['MCP_CATALOG_BOOTSTRAP_CONNECT_TIMEOUT_MS', 'connectTimeoutMs'],
  ] as const)('%s accepts 2147483647', (name, field) => {
    vi.stubEnv(name, '2147483647')
    expect(buildMcpCatalogBootstrapConfig()[field]).toBe(2_147_483_647)
  })

  // These are added to the current time and never armed as timers, so the
  // bound does not apply to them.
  it.each([
    ['MCP_CATALOG_BOOTSTRAP_NEGATIVE_TTL_MS', 'negativeTtlMs'],
    ['MCP_CATALOG_BOOTSTRAP_FAILURE_TTL_MS', 'failureTtlMs'],
    ['MCP_CATALOG_BOOTSTRAP_BACKOFF_MS', 'backoffMs'],
  ] as const)('%s still accepts 2147483648', (name, field) => {
    vi.stubEnv(name, '2147483648')
    expect(buildMcpCatalogBootstrapConfig()[field]).toBe(2_147_483_648)
  })
})
