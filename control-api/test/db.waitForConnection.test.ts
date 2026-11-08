import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { waitForDbConnection } = await import('../src/db.js')

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
    ['57P03'],
  ])('retries %s', async code => {
    const h = harness([codeError(code)])
    await expect(waitForDbConnection(h)).resolves.toBeUndefined()
    expect(h.probe).toHaveBeenCalledTimes(2)
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
    const leaked = 'postgres://control:Synthetic-Password@10.0.0.1:5432/control'
    const h = harness([codeError('ECONNREFUSED', `connect ECONNREFUSED ${leaked}`)])
    await waitForDbConnection(h)
    expect(warnings()).toHaveLength(1)
    const logged = JSON.stringify(warnings()[0])
    expect(logged).toContain('ECONNREFUSED')
    expect(logged).not.toContain('Synthetic-Password')
    expect(logged).not.toContain('postgres://')
  })
})
