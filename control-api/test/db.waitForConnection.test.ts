import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseAllDocuments } from 'yaml'

const logger = vi.hoisted(() => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  log.child.mockReturnValue(log)
  return { rootLogger: log }
})
vi.mock('../src/observability/logger.js', () => logger)

const { DB_WAIT_DEADLINE_MS, DB_WAIT_INTERVAL_MS, corePoolBudget, pool, waitForDbConnection } =
  await import('../src/db.js')

function codeError(code: string, message = `synthetic ${code}`): Error {
  return Object.assign(new Error(message), { code })
}

// A fake clock: sleep advances it, so the deadline is reached without waiting.
function harness(failures: Array<unknown>) {
  let clock = 1_000_000
  const probe = vi.fn(async () => {
    const next = failures.shift()
    if (next !== undefined) throw next
    return { rows: [{ '?column?': 1 }] }
  })
  const sleep = vi.fn(async (ms: number) => {
    clock += ms
  })
  return { probe, sleep, now: () => clock, ensureActive: vi.fn() }
}

const warnings = () =>
  logger.rootLogger.warn.mock.calls.filter(
    ([fields]) => (fields as { event?: string }).event === 'control_api_database_wait'
  )

describe('waitForDbConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    logger.rootLogger.child.mockReturnValue(logger.rootLogger)
  })

  it('waits through connection errors and resolves once Postgres answers', async () => {
    const h = harness([
      codeError('ECONNREFUSED'),
      new Error('Connection terminated due to connection timeout'),
    ])
    await expect(waitForDbConnection(h)).resolves.toBeUndefined()
    expect(h.probe).toHaveBeenCalledTimes(3)
    expect(h.sleep).toHaveBeenCalledTimes(2)
    expect(warnings().map(([fields]) => (fields as { code: string }).code)).toEqual([
      'ECONNREFUSED',
      'connection_timeout',
    ])
  })

  it('fails at once on an error that is not about reaching Postgres', async () => {
    const auth = codeError('28P01', 'password authentication failed')
    const h = harness([auth])
    await expect(waitForDbConnection(h)).rejects.toBe(auth)
    // Witness: the probe ran once; no warning and no sleep followed it.
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.sleep).not.toHaveBeenCalled()
    expect(warnings()).toHaveLength(0)
  })

  it('gives up with the last error once the deadline passes', async () => {
    const errors = Array.from({ length: 100 }, (_, i) => codeError('ECONNREFUSED', `attempt ${i}`))
    const h = harness(errors)
    const result = waitForDbConnection({ ...h, deadlineMs: 10_000, intervalMs: 2_000 })
    await expect(result).rejects.toMatchObject({ code: 'ECONNREFUSED', message: 'attempt 5' })
    // Attempts at t = 0, 2, 4, 6, 8, 10 s: the sixth is at the deadline and throws.
    expect(h.probe).toHaveBeenCalledTimes(6)
    expect(warnings()).toHaveLength(5)
  })

  it.each([
    ['ECONNREFUSED'],
    ['ENOTFOUND'],
    ['EAI_AGAIN'],
    ['ETIMEDOUT'],
    ['ECONNRESET'],
    ['EHOSTUNREACH'],
    ['ENETUNREACH'],
    ['57P01'],
    ['57P03'],
  ])('retries %s', async code => {
    const h = harness([codeError(code)])
    await expect(waitForDbConnection(h)).resolves.toBeUndefined()
    expect(h.probe).toHaveBeenCalledTimes(2)
  })

  it('retries a connection the server closed without an error message', async () => {
    // pg's Client raises this when the socket ends without a client-side end().
    const h = harness([new Error('Connection terminated unexpectedly')])
    await expect(waitForDbConnection(h)).resolves.toBeUndefined()
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(warnings().map(([fields]) => (fields as { code: string }).code)).toEqual([
      'connection_terminated',
    ])
  })

  it.each([
    ['a full pool', new Error('timeout exceeded when trying to connect')],
    ['a client ended by shutdown', new Error('Connection terminated')],
    ['an authentication failure', codeError('28P01')],
    ['a missing database', codeError('3D000')],
  ])('does not retry %s', async (_label, error) => {
    const h = harness([error])
    await expect(waitForDbConnection(h)).rejects.toBe(error)
    expect(h.probe).toHaveBeenCalledTimes(1)
  })

  it('stops when shutdown is requested during the wait', async () => {
    const h = harness([codeError('ECONNREFUSED'), codeError('ECONNREFUSED')])
    const interrupted = new Error('Control API startup interrupted by shutdown')
    h.ensureActive
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw interrupted
      })
    await expect(waitForDbConnection(h)).rejects.toBe(interrupted)
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.sleep).toHaveBeenCalledTimes(1)
  })

  it('logs the error code and never the error message', async () => {
    const h = harness([codeError('ECONNREFUSED', 'connect ECONNREFUSED synthetic-leak-marker')])
    await waitForDbConnection(h)
    // The exact call: any added field (an `err`, the message, the error itself)
    // fails here. JSON.stringify cannot see an Error's message, so it is not used.
    expect(warnings()).toEqual([
      [
        { event: 'control_api_database_wait', attempt: 1, code: 'ECONNREFUSED' },
        'Database not reachable yet; waiting',
      ],
    ])
  })
})

describe('waitForDbConnection defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('probes the core pool with SELECT 1 every 2 s and gives up at 90 s', async () => {
    const query = vi.spyOn(pool, 'query').mockRejectedValue(codeError('ECONNREFUSED'))
    let settled = false
    const result = waitForDbConnection({ ensureActive: () => undefined }).finally(() => {
      settled = true
    })
    result.catch(() => undefined)

    // Literal times on purpose: this test pins the production defaults.
    await vi.advanceTimersByTimeAsync(88_000)
    // Probes at 0, 2, ..., 88 s: still waiting before the deadline.
    expect(settled).toBe(false)
    expect(query).toHaveBeenCalledTimes(45)
    expect(query).toHaveBeenNthCalledWith(1, 'SELECT 1')

    await vi.advanceTimersByTimeAsync(2_000)
    // The probe at 90 s is at the deadline and throws.
    expect(settled).toBe(true)
    await expect(result).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(query).toHaveBeenCalledTimes(46)
  })
})

describe('control-api startupProbe budget', () => {
  it('covers the boot wait, one connection timeout and the boot work around it', () => {
    const docs = parseAllDocuments(
      readFileSync(
        new URL('../../deploy/base/control-plane/control-api.yaml', import.meta.url),
        'utf8'
      )
    ).map(doc => doc.toJS())
    const deployment = docs.find(doc => doc?.kind === 'Deployment')
    const container = deployment.spec.template.spec.containers.find(
      (c: { name: string }) => c.name === 'control-api'
    )
    const { initialDelaySeconds = 0, periodSeconds, failureThreshold } = container.startupProbe
    // The first probe can run as soon as initialDelaySeconds have passed, and
    // the kubelet restarts the container at the failureThreshold-th consecutive
    // failure, so the earliest restart is (failureThreshold - 1) periods later.
    const earliestRestartMs = (initialDelaySeconds + (failureThreshold - 1) * periodSeconds) * 1000
    // The manifest comment's own figures: ~5 s process start before the wait,
    // ~1.5 s from database ready to running after it.
    const bootWorkMs = 6_500
    expect(earliestRestartMs).toBeGreaterThan(
      DB_WAIT_DEADLINE_MS +
        DB_WAIT_INTERVAL_MS +
        corePoolBudget().connectionTimeoutMillis +
        bootWorkMs
    )
  })
})
