import { afterEach, describe, expect, it, vi } from 'vitest'

// A JSON.parse SyntaxError quotes a slice of its input, so logging the error
// object from a config parse failure can publish part of a secret held in that
// variable. The parse sites log the error name only.
// The random token comes first because the parser quotes only the characters
// around the error position; the trailing marker keeps the public-boundary
// scanner from reading the synthetic value as a credential.
const LEAK_PROBE = 'zq7Xv9Lp2Wm4Rk8T'
const SECRET = `${LEAK_PROBE}-synthetic`
const INVALID_JSON = `{"apiKey": ${SECRET}}`

const PARSE_FAILURES = [
  ['CLERUM_HOST_CONFIG', 'Failed to parse dev Host configuration'],
  ['CLERUM_MCP_SERVERS', 'Failed to parse dev MCP servers'],
  ['CLERUM_GUARDRAILS_CONFIG', 'Failed to parse guardrails configuration'],
  ['CLERUM_APPROVAL_CONFIG', 'Failed to parse approval configuration'],
] as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('./logger')
  vi.resetModules()
})

function serialize(args: unknown[]): string {
  return JSON.stringify(args, (_key, value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value
  )
}

describe('config JSON parse failure logging', () => {
  it('logs only the error name when a JSON variable carrying a secret is invalid', async () => {
    vi.resetModules()
    const calls: unknown[][] = []
    const record =
      (level: string) =>
      (...args: unknown[]) => {
        calls.push([level, ...args])
      }
    vi.doMock('./logger', () => ({
      logger: {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      },
      redactUnknown: (value: unknown) => value,
    }))
    vi.stubEnv('CLERUM_DEV_MODE', 'true')
    for (const [name] of PARSE_FAILURES) vi.stubEnv(name, INVALID_JSON)

    // Precondition: the parser itself quotes the secret, so the leak is real.
    expect(() => JSON.parse(INVALID_JSON)).toThrow(LEAK_PROBE.slice(0, 4))

    await import('./config')

    // Witness: every parse site reached its failure log.
    const failureLogs = calls.filter(([level]) => level === 'error')
    expect(failureLogs.map(call => call[2]).sort()).toEqual(
      PARSE_FAILURES.map(([, message]) => message).sort()
    )

    const logged = serialize(calls)
    for (let start = 0; start + 4 <= LEAK_PROBE.length; start++) {
      expect(logged).not.toContain(LEAK_PROBE.slice(start, start + 4))
    }
    for (const call of failureLogs) {
      expect(call[1]).toEqual({ component: 'Config', errorName: 'SyntaxError' })
    }
  })
})
