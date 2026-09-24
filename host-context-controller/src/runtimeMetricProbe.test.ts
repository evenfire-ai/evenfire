import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { initialConvergenceLastSuccessTimestampSeconds, registry } from './metrics'

const source = readFileSync(
  resolve(__dirname, '../../scripts/e2e/_lib/hcc-watch-runtime-metric.cjs'),
  'utf8'
)
const name = 'clerum_hcc_initial_convergence_last_success_timestamp_seconds'

class ProbeExit extends Error {
  constructor(readonly status: number) {
    super('probe exited')
  }
}

function probe(body: string, statusCode = 200, threshold = new Date(100000).toISOString()): number {
  const events = new Map<string, (value?: unknown) => void>()
  const response = {
    statusCode,
    on(event: string, callback: (value?: unknown) => void) {
      events.set(event, callback)
      return response
    },
  }
  const request = {
    on() {
      return request
    },
  }
  try {
    runInNewContext(source, {
      AbortSignal,
      process: {
        argv: ['node', '-', threshold],
        exit(status: number) {
          throw new ProbeExit(status)
        },
      },
      require(module: string) {
        if (module === './dist/config') return { config: { port: 19081 } }
        if (module === 'node:http')
          return {
            get(
              options: { port: number; path: string },
              callback: (value: typeof response) => void
            ) {
              expect(options.port).toBe(19081)
              expect(options.path).toBe('/metrics')
              callback(response)
              return request
            },
          }
        throw new Error('unexpected probe dependency')
      },
    })
    events.get('data')?.(body)
    events.get('end')?.()
    return 0
  } catch (error) {
    if (error instanceof ProbeExit) return error.status
    throw error
  }
}

afterEach(() => initialConvergenceLastSuccessTimestampSeconds.remove({ lane: 'McpServer' }))

describe('runtime completion probe', () => {
  it('accepts the actual HCC registry rendering with its default service label', async () => {
    initialConvergenceLastSuccessTimestampSeconds.set({ lane: 'McpServer' }, 123)
    const body = await registry.metrics()
    expect(body).toContain('service="host-context-controller"')
    expect(probe(body)).toBe(0)
  })

  it.each([
    'lane="McpServer"',
    'lane="McpServer",service="host-context-controller"',
    'service="host-context-controller",lane="McpServer"',
    'other="a,b", lane = "McpServer",service="host-context-controller"',
    String.raw`quoted="a\"b",escaped="a\\b\nc",lane="McpServer"`,
  ])('accepts valid label order/additions: %s', labels => {
    expect(probe(`${name}{${labels}} 1.23e2\n`)).toBe(0)
  })

  it('preserves the exact threshold and metric/lane selection', () => {
    expect(probe(`${name}{lane="McpServer"} 100\n`)).toBe(0)
    expect(
      probe(
        `${name}_other{lane="McpServer"} 999\n${name}{lane="NetworkPolicy"} 999\n${name}{lane="McpServer"} 99\n`
      )
    ).toBe(1)
    expect(probe(`${name}_other{lane="McpServer"} 999\n`)).toBe(1)
  })

  it.each([
    '',
    `${name}{lane="NetworkPolicy"} 123`,
    `${name}{service="host-context-controller"} 123`,
    `${name}{lane="McpServer"} 123\n${name}{service="other",lane="McpServer"} 124`,
    `${name}{lane="McpServer",lane="McpServer"} 123`,
    `${name}{lane="McpServer",extra="a",extra="b"} 123`,
    `${name}{lane="McpServer"} NaN`,
    `${name}{lane="McpServer"} +Inf`,
    `${name}{lane="McpServer"} 1e999`,
    `${name}{lane="McpServer"} 1e+`,
    `${name}{lane="McpServer"} 1.2.3`,
    `${name}{lane="McpServer"} 123 garbage`,
    `${name}{lane="McpServer",} 123`,
    `${name}{lane="McpServer",bad} 123`,
    `${name}{lane="McpServer} 123`,
    String.raw`${name}{lane="McpServer",bad="invalid\t"} 123`,
    `${name}{lane="McpServer"} 99.999`,
  ])('rejects missing, ambiguous, malformed or stale sample %#', body => {
    expect(probe(body)).toBe(1)
  })

  it('rejects HTTP failure and an invalid completion threshold', () => {
    expect(probe(`${name}{lane="McpServer"} 123`, 503)).toBe(1)
    expect(probe(`${name}{lane="McpServer"} 123`, 200, 'invalid')).toBe(1)
  })
})
