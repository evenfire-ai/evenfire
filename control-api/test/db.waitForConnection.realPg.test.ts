import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Server, type Socket, createServer } from 'node:net'

// The boot wait with its production default probe and a real pg Pool, against
// a fake Postgres that fails in the ways a moving or frozen server does. The
// unit suite injects the probe errors; this one checks that pg really raises
// them, with the messages the wait maps, and that a frozen server is bounded.

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

type Mode = 'silent-handshake' | 'close-after-handshake' | 'hang-after-handshake'

type FakePostgres = {
  port: number
  connections: () => number
  handshakes: () => number
  queries: () => number
  stop: () => Promise<void>
}

// AuthenticationOk ('R', length 8, code 0) then ReadyForQuery ('Z', length 5, idle).
const HANDSHAKE_REPLY = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49])

async function startFakePostgres(mode: Mode): Promise<FakePostgres> {
  const sockets = new Set<Socket>()
  let connections = 0
  let handshakes = 0
  let queries = 0
  const server: Server = createServer(socket => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // The client resets the socket when it gives up; that is the case under test.
    socket.on('error', () => sockets.delete(socket))
    if (mode === 'silent-handshake') return

    let buffered = Buffer.alloc(0)
    let started = false
    socket.on('data', chunk => {
      // No encoding is set on the socket, so pg's protocol bytes arrive as a Buffer.
      if (typeof chunk === 'string') throw new Error('fake Postgres received text, not bytes')
      buffered = Buffer.concat([buffered, chunk])
      for (;;) {
        if (!started) {
          // The startup message has no type byte: Int32 length, then the body.
          if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return
          buffered = buffered.subarray(buffered.readInt32BE(0))
          started = true
          handshakes += 1
          socket.write(HANDSHAKE_REPLY)
          continue
        }
        if (buffered.length < 5 || buffered.length < 1 + buffered.readInt32BE(1)) return
        const type = String.fromCharCode(buffered[0] as number)
        buffered = buffered.subarray(1 + buffered.readInt32BE(1))
        if (type === 'X') {
          socket.end()
          return
        }
        if (type !== 'Q') continue
        queries += 1
        if (mode === 'close-after-handshake') {
          socket.destroy()
          return
        }
        // hang-after-handshake: the query is read and never answered.
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake Postgres has no TCP port')
  return {
    port: address.port,
    connections: () => connections,
    handshakes: () => handshakes,
    queries: () => queries,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

// A port that was bound and released, so nothing listens on it.
async function refusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('probe server has no TCP port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

const waitCodes = (): string[] =>
  logger.rootLogger.warn.mock.calls
    .filter(([fields]) => (fields as { event?: string }).event === 'control_api_database_wait')
    .map(([fields]) => (fields as { code: string }).code)

type Db = typeof import('../src/db.js')

describe('waitForDbConnection against a fake Postgres', () => {
  let fake: FakePostgres | null = null
  let db: Db | null = null

  async function loadDb(port: number): Promise<Db> {
    vi.stubEnv('CONTROL_API_PG_CONNECTION_STRING', `postgres://u:p@127.0.0.1:${port}/profiles`)
    vi.stubEnv('CORE_POOL_CONNECTION_TIMEOUT_MS', '300')
    vi.resetModules()
    db = await import('../src/db.js')
    return db
  }

  async function waitAgainst(port: number): Promise<{ error: unknown; elapsedMs: number }> {
    const { waitForDbConnection } = await loadDb(port)
    const started = Date.now()
    const error = await waitForDbConnection({
      ensureActive: () => undefined,
      deadlineMs: 3_000,
      intervalMs: 100,
    }).then(
      () => new Error('the wait resolved against a Postgres that never answers'),
      (err: unknown) => err
    )
    return { error, elapsedMs: Date.now() - started }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    logger.rootLogger.child.mockReturnValue(logger.rootLogger)
  })

  afterEach(async () => {
    // Destroy the fake sockets first, so the pools' clients end at once.
    await fake?.stop()
    fake = null
    await db?.pool.end()
    await db?.rateLimitPool.end()
    db = null
    vi.unstubAllEnvs()
  })

  it('retries a server that accepts the connection and never answers the handshake', async () => {
    fake = await startFakePostgres('silent-handshake')
    const { error } = await waitAgainst(fake.port)

    expect(error).toMatchObject({ message: 'Connection terminated due to connection timeout' })
    expect(waitCodes().length).toBeGreaterThanOrEqual(1)
    expect(new Set(waitCodes())).toEqual(new Set(['connection_timeout']))
    // Witness: the probes reached the server and stopped before the handshake.
    expect(fake.connections()).toBeGreaterThanOrEqual(2)
    expect(fake.handshakes()).toBe(0)
  }, 15_000)

  it('retries a server that closes the connection when it gets the query', async () => {
    fake = await startFakePostgres('close-after-handshake')
    const { error } = await waitAgainst(fake.port)

    expect(error).toMatchObject({ message: 'Connection terminated unexpectedly' })
    expect(waitCodes().length).toBeGreaterThanOrEqual(1)
    expect(new Set(waitCodes())).toEqual(new Set(['connection_terminated']))
    // Witness: every failure came after a completed handshake and a sent query.
    expect(fake.queries()).toBeGreaterThanOrEqual(2)
    expect(fake.handshakes()).toBe(fake.queries())
  }, 15_000)

  it('bounds and retries a probe that a frozen server never answers', async () => {
    fake = await startFakePostgres('hang-after-handshake')
    const { error, elapsedMs } = await waitAgainst(fake.port)

    expect(error).toMatchObject({ message: 'Query read timeout' })
    expect(waitCodes()).toEqual(['query_timeout'])
    // Probes at 0 s and 2.1 s, each cut at 2 s; the second ends past the 3 s deadline.
    expect(fake.queries()).toBe(2)
    expect(elapsedMs).toBeGreaterThanOrEqual(4_000)
    expect(elapsedMs).toBeLessThan(6_000)
  }, 15_000)

  it('retries a refused connection', async () => {
    const port = await refusedPort()
    const { error } = await waitAgainst(port)

    expect(error).toMatchObject({ code: 'ECONNREFUSED' })
    expect(waitCodes().length).toBeGreaterThanOrEqual(2)
    expect(new Set(waitCodes())).toEqual(new Set(['ECONNREFUSED']))
  }, 15_000)
})
