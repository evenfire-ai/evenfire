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
