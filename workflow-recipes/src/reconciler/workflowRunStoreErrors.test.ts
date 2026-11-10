import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import { Pool } from 'pg'
import { WorkflowAuthorityCheckpointError } from './workflowActionCheckpointClient.js'
import {
  classifyWorkflowRunStoreError,
  isWorkflowRunStoreUnreachable,
} from './workflowRunStoreErrors.js'

/**
 * The driver errors are produced by the real `pg` / `pg-pool` of this package
 * against loopback endpoints, so a driver upgrade that changes one of the
 * matched messages fails here instead of silently turning an outage into a
 * 500 (or a defect into a wait).
 */

type CapturedErrors = {
  closedPort: unknown
  queuedAcquire: unknown
  connectTimeout: unknown
  closingServer: unknown
}

const servers: net.Server[] = []
const sockets: net.Socket[] = []
let captured: CapturedErrors

function listen(onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(onConnection)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function portOf(server: net.Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no loopback port')
  return address.port
}

function rejectionOf(promise: Promise<{ release: () => void }>): Promise<unknown> {
  return promise.then(
    client => {
      client.release()
      throw new Error('the pool connected where a failure was expected')
    },
    (error: unknown) => error
  )
}

async function captureClosedPort(): Promise<unknown> {
  const server = await listen(() => {})
  const port = portOf(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
  const pool = new Pool({ host: '127.0.0.1', port, user: 'x', database: 'x' })
  pool.on('error', () => {})
  try {
    return await rejectionOf(pool.connect())
  } finally {
    await pool.end()
  }
}

async function captureSilentServer(): Promise<{ queuedAcquire: unknown; connectTimeout: unknown }> {
  const server = await listen(socket => sockets.push(socket))
  const pool = new Pool({
    host: '127.0.0.1',
    port: portOf(server),
    user: 'x',
    database: 'x',
    max: 1,
    connectionTimeoutMillis: 300,
  })
  pool.on('error', () => {})
  try {
    const [connectTimeout, queuedAcquire] = await Promise.all([
      rejectionOf(pool.connect()),
      rejectionOf(pool.connect()),
    ])
    return { queuedAcquire, connectTimeout }
  } finally {
    for (const socket of sockets) socket.destroy()
    await pool.end()
  }
}

async function captureClosingServer(): Promise<unknown> {
  const server = await listen(socket => socket.destroy())
  const pool = new Pool({ host: '127.0.0.1', port: portOf(server), user: 'x', database: 'x' })
  pool.on('error', () => {})
  try {
    return await rejectionOf(pool.connect())
  } finally {
    await pool.end()
  }
}

beforeAll(async () => {
  const closedPort = await captureClosedPort()
  const { queuedAcquire, connectTimeout } = await captureSilentServer()
  const closingServer = await captureClosingServer()
  captured = { closedPort, queuedAcquire, connectTimeout, closingServer }
})

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('classifyWorkflowRunStoreError: errors captured from the real driver', () => {
  it('pins the captured driver errors to the texts the classifier matches', () => {
    // Witness that each capture is the driver error the case names.
    expect(captured.closedPort).toMatchObject({ code: 'ECONNREFUSED' })
    expect(captured.queuedAcquire).toMatchObject({
      message: 'timeout exceeded when trying to connect',
    })
    expect(captured.connectTimeout).toMatchObject({
      message: 'Connection terminated due to connection timeout',
    })
    expect(captured.closingServer).toMatchObject({
      message: 'Connection terminated unexpectedly',
    })
  })

  it.each([
    ['closed port', 'closedPort', 'network'],
    ['acquire queued for the only pool slot', 'queuedAcquire', 'pool_acquire_timeout'],
    ['server that never answers the handshake', 'connectTimeout', 'connect_timeout'],
    ['server that closes every connection', 'closingServer', 'connection_dropped'],
  ] as const)('classifies a %s as unreachable (%s)', (_label, key, kind) => {
    expect(classifyWorkflowRunStoreError(captured[key])).toBe(kind)
    expect(isWorkflowRunStoreUnreachable(captured[key])).toBe(true)
  })
})

describe('classifyWorkflowRunStoreError: read-only entries', () => {
  it.each(['ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN'])(
    'classifies the system error %s as network',
    code => {
      const error = Object.assign(new Error(`connect ${code}`), { code })
      expect(classifyWorkflowRunStoreError(error)).toBe('network')
      expect(isWorkflowRunStoreUnreachable(error)).toBe(true)
    }
  )

  it('classifies a query on a broken client as client_broken', () => {
    const error = new Error('Client has encountered a connection error and is not queryable')
    expect(classifyWorkflowRunStoreError(error)).toBe('client_broken')
    expect(isWorkflowRunStoreUnreachable(error)).toBe(true)
  })

  it.each([
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '57P01',
    '57P02',
    '57P03',
    '53300',
  ])('classifies SQLSTATE %s as server_connection_loss', code => {
    expect(classifyWorkflowRunStoreError({ code })).toBe('server_connection_loss')
    expect(isWorkflowRunStoreUnreachable({ code })).toBe(true)
  })
})

describe('classifyWorkflowRunStoreError: errors that stay loud', () => {
  it.each([
    ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' })],
    ['28P01 (authentication)', { code: '28P01' }],
    ['3D000 (missing database)', { code: '3D000' }],
    ['42P01 (missing relation)', { code: '42P01' }],
    ['23514 (check constraint)', { code: '23514' }],
    ['40P01 (deadlock)', { code: '40P01' }],
    ['08P01 (protocol violation)', { code: '08P01' }],
    ['our own end()', new Error('Connection terminated')],
    ['a TypeError', new TypeError('cannot read properties of undefined')],
    [
      'the binding-changed checkpoint error',
      new WorkflowAuthorityCheckpointError('authority_unavailable', true),
    ],
    [
      'a pool acquire timeout message that carries a code',
      Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'XX000' }),
    ],
    ['null', null],
    ['a string', 'ECONNREFUSED'],
  ])('classifies %s as other', (_label, error) => {
    expect(classifyWorkflowRunStoreError(error)).toBe('other')
    expect(isWorkflowRunStoreUnreachable(error)).toBe(false)
  })
})
