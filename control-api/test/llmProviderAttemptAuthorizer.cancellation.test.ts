import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { type Socket, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { withTransaction } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import {
  LlmProviderAttemptAuthorizeError,
  authorizeLlmProviderAttempt,
} from '../src/services/llmProviderAttemptAuthorizer.js'
import { ResourceService } from '../src/services/resourceService.js'
import type { McpHostAccessClaims } from '../src/utils/auth/mcpHostJwtToken.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dependency did not terminate')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function observed(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('lifecycle observation did not arrive')
    await nextTurn()
  }
}

function interruption(code: 'authorize_timeout' | 'authorize_aborted') {
  return Object.assign(new Error(code), { code })
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map(close => close()))
})

describe('authorizer Kubernetes cancellation on the configured native client', () => {
  let directory: string
  let certificate: Buffer
  let key: Buffer
  beforeAll(() => {
    // Generate disposable TLS material locally. No application credentials or
    // checked-in private key are needed to prove the configured CA/auth path.
    directory = mkdtempSync(join(tmpdir(), 'authorize-cancel-tls-'))
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(directory, 'fixture-key.pem'),
        '-out',
        join(directory, 'fixture-cert.pem'),
      ],
      { stdio: 'ignore', timeout: 10_000 }
    )
    certificate = readFileSync(join(directory, 'fixture-cert.pem'))
    key = readFileSync(join(directory, 'fixture-key.pem'))
  })
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  async function peer(mode: 'no-headers' | 'no-eof') {
    const arrived = deferred()
    const disconnected = deferred()
    const sockets = new Set<Duplex>()
    const requests: Array<{ authorization?: string; url?: string }> = []
    let complete = false
    const server = createHttpsServer({ cert: certificate, key }, (req, res) => {
      requests.push({ authorization: req.headers.authorization, url: req.url })
      req.socket.once('close', () => disconnected.resolve())
      arrived.resolve()
      if (complete) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ metadata: { name: 'cancel-host' } }))
      } else if (mode === 'no-eof') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"metadata":')
      }
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing TLS address')
    const bearer = randomUUID()
    const options: Parameters<k8s.KubeConfig['loadFromOptions']>[0] = {
      clusters: [
        {
          name: 'fixture',
          server: `https://127.0.0.1:${address.port}`,
          caData: certificate.toString('base64'),
          skipTLSVerify: false,
        },
      ],
      users: [{ name: 'fixture', token: bearer }],
      contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }],
      currentContext: 'fixture',
    }
    const kubeconfig = new k8s.KubeConfig()
    kubeconfig.loadFromOptions(options)
    const resources = new ResourceService(
      kubeconfig.makeApiClient(k8s.CustomObjectsApi),
      'default',
      { hosts: 'default' }
    )
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    })
    return {
      arrived,
      disconnected,
      requests,
      bearer,
      resources,
      options,
      recover: () => {
        complete = true
      },
    }
  }

  it.each(['no-headers', 'no-eof'] as const)(
    'terminates %s with the configured CA, bearer and server intact, then serves a later lookup',
    async mode => {
      const fixture = await peer(mode)
      const controller = new AbortController()
      const reason = interruption('authorize_timeout')
      const outcome = fixture.resources
        .getResource('hosts', 'cancel-host', 'default', controller.signal)
        .then(
          value => ({ value }),
          error => ({ error })
        )
      await fixture.arrived.promise
      controller.abort(reason)
      expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
      await within(fixture.disconnected.promise)
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.requests[0].authorization).toBe(`Bearer ${fixture.bearer}`)
      expect(fixture.requests[0].url).toContain('/namespaces/default/hosts/cancel-host')
      fixture.recover()
      await expect(
        fixture.resources.getResource('hosts', 'cancel-host', 'default')
      ).resolves.toMatchObject({ metadata: { name: 'cancel-host' } })
      expect(fixture.requests).toHaveLength(2)
    }
  )

  it('does not enter the cross-namespace fallback after cancellation without an explicit namespace', async () => {
    const fixture = await peer('no-headers')
    const controller = new AbortController()
    const reason = interruption('authorize_aborted')
    const outcome = fixture.resources
      .getResource('hosts', 'cancel-host', undefined, controller.signal)
      .then(
        value => ({ value }),
        error => ({ error })
      )
    await fixture.arrived.promise
    controller.abort(reason)
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(fixture.requests).toHaveLength(1)
  })

  it('forwards the optional signal through K8sGateway without reconfiguring its client', async () => {
    const fixture = await peer('no-headers')
    vi.spyOn(k8s.KubeConfig.prototype, 'loadFromDefault').mockImplementation(function (
      this: k8s.KubeConfig
    ) {
      this.loadFromOptions(fixture.options)
    })
    const gateway = new K8sGateway('default')
    const controller = new AbortController()
    const reason = interruption('authorize_aborted')
    const outcome = gateway
      .getResource('hosts', 'cancel-host', config.hostsNamespace, controller.signal)
      .then(
        value => ({ value }),
        error => ({ error })
      )
    await fixture.arrived.promise
    controller.abort(reason)
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(fixture.requests[0].authorization).toBe(`Bearer ${fixture.bearer}`)
  })

  it.each(['codex-subscription', 'grok-subscription'] as const)(
    'propagates %s cancellation into assignment and never enters a transaction',
    async provider => {
      const fixture = await peer('no-headers')
      const previous = config.grokSubscriptionEnabled
      config.grokSubscriptionEnabled = true
      try {
        const controller = new AbortController()
        const reason = interruption('authorize_timeout')
        const transaction = vi.fn()
        const caller: McpHostAccessClaims = {
          sub: 'default/cancel-host',
          hostRefs: ['cancel-host'],
          recipeNamespace: 'default',
          recipeName: 'cancel-host',
          scope: 'workflow:approval:request',
          mcpCapabilities: [],
          workflowControlScopes: ['llm:codex:execute', 'llm:grok:execute'],
          iss: 'control-api',
          aud: 'workflow-approvals',
          jti: randomUUID(),
          exp: Math.floor(Date.now() / 1_000) + 60,
        }
        const outcome = authorizeLlmProviderAttempt(
          caller,
          {
            invocationId: randomUUID(),
            attemptGeneration: 1,
            policyRevision: 1,
            policyHash: 'a'.repeat(64),
            request: {
              schemaVersion:
                provider === 'codex-subscription'
                  ? 'codex-completion-request.v1'
                  : 'grok-completion-request.v1',
              requestId: randomUUID(),
              idempotencyKey: randomUUID(),
              provider,
              model: provider === 'codex-subscription' ? 'gpt-5.1' : 'grok-4',
              messages: [{ role: 'user', content: 'cancel this lookup' }],
            },
          },
          {
            enabled: true,
            signal: controller.signal,
            withTransaction: transaction,
            resolveAssignment: async (_hostRef, signal) => {
              try {
                await fixture.resources.getResource('hosts', 'cancel-host', 'default', signal)
              } catch {
                // Existing assignment adapters translate lookup errors. The
                // authorizer must recover the typed cancellation through them.
                throw new LlmProviderAttemptAuthorizeError(
                  'host_binding_mismatch',
                  'assignment lookup failed'
                )
              }
              return { liveBrokerProviders: [provider], liveConnectionRef: 'connection-fixture' }
            },
          }
        ).then(
          value => ({ value }),
          error => ({ error })
        )
        await fixture.arrived.promise
        controller.abort(reason)
        expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
        await within(fixture.disconnected.promise)
        expect(transaction).not.toHaveBeenCalled()
      } finally {
        config.grokSubscriptionEnabled = previous
      }
    }
  )
})

function protocolMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(type, 0)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

function textRows(columns: string[], values: Array<string | null>): Buffer[] {
  const count = Buffer.alloc(2)
  count.writeInt16BE(columns.length)
  const fields = columns.map(name => {
    const description = Buffer.alloc(18)
    description.writeInt32BE(25, 6)
    description.writeInt16BE(-1, 10)
    description.writeInt32BE(-1, 12)
    return Buffer.concat([Buffer.from(`${name}\0`), description])
  })
  const row = values.map(value => {
    const bytes = value === null ? undefined : Buffer.from(value)
    const length = Buffer.alloc(4)
    length.writeInt32BE(bytes?.length ?? -1)
    return bytes ? Buffer.concat([length, bytes]) : length
  })
  return [
    protocolMessage('T', Buffer.concat([count, ...fields])),
    protocolMessage('D', Buffer.concat([count, ...row])),
  ]
}

async function postgresPeer(
  handshake = true,
  settings: { statement?: string | null; idle?: string | null } = {}
) {
  const connected = deferred()
  const queries: string[] = []
  const sessionChanges: Array<{ sql: string; values: Array<string | null> }> = []
  const lifecycle: string[] = []
  const sockets = new Set<Socket>()
  const stalledReplies: Array<() => void> = []
  let stalledSql = ''
  let stalledOccurrence = 1
  let failedSql = ''
  let failedOccurrence = 1
  const occurrences = new Map<string, number>()
  const server = createTcpServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    connected.resolve()
    let startup = true
    let buffered = Buffer.alloc(0)
    let statement = ''
    let parameters: Array<string | null> = []
    let state = 'I'
    let waiting = false
    let pendingSync = false
    let idleTimeout = settings.idle === undefined ? '0' : settings.idle
    const statementTimeout = settings.statement === undefined ? '15000' : settings.statement
    const ready = () => socket.write(protocolMessage('Z', Buffer.from(state)))
    const describe = (sql: string): [string[], Array<string | null>] => {
      if (sql.includes('FROM pg_settings')) {
        return [
          ['statement_timeout_ms', 'idle_timeout_ms'],
          [statementTimeout, idleTimeout],
        ]
      }
      if (sql === 'SELECT set_config($1, $2, false)') return [['set_config'], [parameters[1]]]
      return [[], []]
    }
    const execute = (sql: string, simple: boolean) => {
      queries.push(sql)
      const occurrence = (occurrences.get(sql) ?? 0) + 1
      occurrences.set(sql, occurrence)
      if (sql === 'SELECT set_config($1, $2, false)') {
        sessionChanges.push({ sql, values: [...parameters] })
      }
      const complete = () => {
        if (sql === failedSql && occurrence === failedOccurrence) {
          if (state === 'T') state = 'E'
          socket.write(
            protocolMessage('E', Buffer.from('SERROR\0C42704\0Mfixture statement failure\0\0'))
          )
        } else {
          if (sql === 'BEGIN') state = 'T'
          if (sql === 'ROLLBACK' || sql === 'COMMIT') state = 'I'
          if (sql === 'SELECT set_config($1, $2, false)') idleTimeout = parameters[1]
          const [columns, values] = describe(sql)
          if (columns.length) {
            const [description, row] = textRows(columns, values)
            if (simple) socket.write(description)
            socket.write(row)
          }
          socket.write(protocolMessage('C', Buffer.from(`${sql.split(' ')[0]}\0`)))
        }
        waiting = false
        if (simple || pendingSync) {
          pendingSync = false
          ready()
        }
      }
      if (sql === stalledSql && occurrence === stalledOccurrence) {
        waiting = true
        stalledReplies.push(complete)
      } else complete()
    }
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (startup) {
        if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return
        buffered = buffered.subarray(buffered.readInt32BE(0))
        startup = false
        if (handshake)
          socket.write(
            Buffer.concat([
              protocolMessage('R', Buffer.alloc(4)),
              protocolMessage('Z', Buffer.from('I')),
            ])
          )
      }
      while (buffered.length >= 5 && buffered.length >= buffered.readInt32BE(1) + 1) {
        const type = buffered.toString('utf8', 0, 1)
        const length = buffered.readInt32BE(1)
        const body = buffered.subarray(5, length + 1)
        buffered = buffered.subarray(length + 1)
        if (type === 'Q') {
          parameters = []
          execute(body.toString('utf8', 0, body.length - 1), true)
        } else if (type === 'P') {
          const start = body.indexOf(0) + 1
          statement = body.toString('utf8', start, body.indexOf(0, start))
          socket.write(protocolMessage('1', Buffer.alloc(0)))
        } else if (type === 'B') {
          let offset = body.indexOf(0) + 1
          offset = body.indexOf(0, offset) + 1
          const formats = body.readInt16BE(offset)
          offset += 2 + formats * 2
          const count = body.readInt16BE(offset)
          offset += 2
          parameters = []
          for (let index = 0; index < count; index++) {
            const size = body.readInt32BE(offset)
            offset += 4
            parameters.push(size < 0 ? null : body.toString('utf8', offset, offset + size))
            if (size >= 0) offset += size
          }
          socket.write(protocolMessage('2', Buffer.alloc(0)))
        } else if (type === 'D') {
          const [columns, values] = describe(statement)
          socket.write(
            columns.length ? textRows(columns, values)[0] : protocolMessage('n', Buffer.alloc(0))
          )
        } else if (type === 'E') execute(statement, false)
        else if (type === 'S') {
          if (waiting) pendingSync = true
          else ready()
        }
      }
    })
    // This deliberate half-open peer never sends EOF in response to Terminate.
    // pg's idle Client.end() alone cannot finish; the scoped transport stop must.
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing PG address')
  const pool = new Pool({
    host: '127.0.0.1',
    port: address.port,
    user: 'cancel_fixture',
    database: 'cancel_fixture',
    max: 1,
    connectionTimeoutMillis: 150,
    idleTimeoutMillis: 1_000,
  })
  pool.on('error', () => {})
  pool.on('connect', client => client.once('end', () => lifecycle.push('end')))
  pool.on('remove', () => lifecycle.push('remove'))
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await pool.end()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  })
  return {
    connected,
    queries,
    sessionChanges,
    lifecycle,
    pool,
    stall: (sql: string, occurrence = 1) => {
      stalledSql = sql
      stalledOccurrence = occurrence
    },
    resume: () => {
      for (const reply of stalledReplies.splice(0)) reply()
    },
    fail: (sql: string, occurrence = 1) => {
      failedSql = sql
      failedOccurrence = occurrence
    },
  }
}

describe('scoped transaction cancellation with the native pg driver and sockets', () => {
  it('never borrows a client for an already aborted request', async () => {
    const fixture = await postgresPeer()
    const borrow = vi.spyOn(fixture.pool, 'connect')
    const controller = new AbortController()
    const reason = interruption('authorize_aborted')
    controller.abort(reason)
    await expect(
      withTransaction(vi.fn(), fixture.pool, { signal: controller.signal })
    ).rejects.toBe(reason)
    expect(borrow).not.toHaveBeenCalled()
    expect(fixture.queries).toEqual([])
  })

  it('fails without running work if the server does not support scoped connection polling', async () => {
    const fixture = await postgresPeer()
    fixture.fail("SET LOCAL client_connection_check_interval = '100ms'")
    const work = vi.fn()
    await expect(
      withTransaction(work, fixture.pool, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: '42704' })
    expect(work).not.toHaveBeenCalled()
    expect(fixture.queries).toEqual([
      expect.stringContaining('FROM pg_settings'),
      'SELECT set_config($1, $2, false)',
      'BEGIN',
      "SET LOCAL client_connection_check_interval = '100ms'",
      'ROLLBACK',
      'SELECT set_config($1, $2, false)',
    ])
  })

  it('terminates an in-flight rollback before final release and preserves the typed owner reason', async () => {
    const fixture = await postgresPeer()
    fixture.stall('ROLLBACK')
    const controller = new AbortController()
    const reason = interruption('authorize_timeout')
    const outcome = withTransaction(
      async () => {
        throw new Error('work failed')
      },
      fixture.pool,
      { signal: controller.signal }
    ).then(
      value => ({ value }),
      error => ({ error })
    )
    await observed(() => fixture.queries.includes('ROLLBACK'))
    const borrowed = (fixture.pool as unknown as { _clients: PoolClient[] })._clients[0]
    const release = vi.spyOn(borrowed, 'release')
    expect(release).not.toHaveBeenCalled()
    controller.abort(reason)
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(reason)
    expect(fixture.pool.totalCount).toBe(0)
    expect(fixture.queries).not.toContain('COMMIT')
  })

  it('terminates an active native query and evicts the client exactly once before recovery', async () => {
    const fixture = await postgresPeer()
    fixture.stall('SELECT stalled')
    const removed = vi.fn()
    fixture.pool.on('remove', removed)
    const controller = new AbortController()
    const reason = interruption('authorize_timeout')
    const outcome = withTransaction(async db => db.query('SELECT stalled'), fixture.pool, {
      signal: controller.signal,
    }).then(
      value => ({ value }),
      error => ({ error })
    )
    await observed(() => fixture.queries.includes('SELECT stalled'))
    controller.abort(reason)
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(fixture.pool.totalCount).toBe(0)
    expect(removed).toHaveBeenCalledOnce()
    expect(fixture.queries).not.toContain('COMMIT')
    await expect(withTransaction(async () => 'later', fixture.pool)).resolves.toBe('later')
    expect(fixture.pool.idleCount).toBe(1)
  })

  it('terminates an idle half-open client but remains owned through callback cleanup', async () => {
    const fixture = await postgresPeer()
    const entered = deferred()
    const callbackCleanup = deferred()
    const controller = new AbortController()
    const reason = interruption('authorize_aborted')
    let settled = false
    const outcome = withTransaction(
      async () => {
        entered.resolve()
        await once(controller.signal, 'abort')
        // This barrier tests ordering only. Physical cancellation above and the
        // native half-open client end event below are independent of its release.
        await callbackCleanup.promise
        return 'late callback'
      },
      fixture.pool,
      { signal: controller.signal }
    )
      .then(
        value => ({ value }),
        error => ({ error })
      )
      .finally(() => {
        settled = true
      })
    await entered.promise
    const borrowed = (fixture.pool as unknown as { _clients: PoolClient[] })._clients[0]
    const clientEnded = once(borrowed, 'end')
    const release = vi.spyOn(borrowed, 'release')
    controller.abort(reason)
    try {
      await within(clientEnded)
      expect(settled).toBe(false)
      expect(release).not.toHaveBeenCalled()
      expect(fixture.pool.totalCount).toBe(1)
    } finally {
      callbackCleanup.resolve()
    }
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(reason)
    expect(fixture.pool.totalCount).toBe(0)
    await expect(withTransaction(async () => 'recovered', fixture.pool)).resolves.toBe('recovered')
  })

  it('awaits bounded connect failure and preserves the cancellation reason without sending BEGIN', async () => {
    const fixture = await postgresPeer(false)
    const controller = new AbortController()
    const reason = interruption('authorize_timeout')
    let settled = false
    const work = vi.fn()
    const outcome = withTransaction(work, fixture.pool, { signal: controller.signal })
      .then(
        value => ({ value }),
        error => ({ error })
      )
      .finally(() => {
        settled = true
      })
    await fixture.connected.promise
    controller.abort(reason)
    await nextTurn()
    expect(settled).toBe(false)
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(work).not.toHaveBeenCalled()
    expect(fixture.queries).toEqual([])
    expect(fixture.pool.totalCount).toBe(0)
  })

  it('disposes a borrow that arrives after abort before any new statement or healthy return', async () => {
    const fixture = await postgresPeer()
    const first = await fixture.pool.connect()
    const controller = new AbortController()
    const reason = interruption('authorize_aborted')
    const work = vi.fn()
    const outcome = withTransaction(work, fixture.pool, { signal: controller.signal }).then(
      value => ({ value }),
      error => ({ error })
    )
    await observed(() => fixture.pool.waitingCount === 1)
    controller.abort(reason)
    first.release()
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(work).not.toHaveBeenCalled()
    expect(fixture.queries).toEqual([])
    expect(fixture.pool.totalCount).toBe(0)
    await expect(withTransaction(async () => 'recovered', fixture.pool)).resolves.toBe('recovered')
  })

  it('keeps a lost COMMIT reply uncertain and never attempts rollback or returns that client healthy', async () => {
    const fixture = await postgresPeer()
    fixture.stall('COMMIT')
    const controller = new AbortController()
    const reason = interruption('authorize_timeout')
    const outcome = withTransaction(async () => 'possibly committed', fixture.pool, {
      signal: controller.signal,
    }).then(
      value => ({ value }),
      error => ({ error })
    )
    await observed(() => fixture.queries.includes('COMMIT'))
    controller.abort(reason)
    expect(((await within(outcome)) as { error: unknown }).error).toBe(reason)
    expect(fixture.queries).toEqual([
      expect.stringContaining('FROM pg_settings'),
      'SELECT set_config($1, $2, false)',
      'BEGIN',
      "SET LOCAL client_connection_check_interval = '100ms'",
      'COMMIT',
    ])
    expect(fixture.pool.totalCount).toBe(0)
  })
})

describe('cancellable transaction server idle backstop with native pool max one', () => {
  const settingSql = 'SELECT set_config($1, $2, false)'

  it.each(['0', '45000'])(
    'bounds an effective idle timeout of %s before BEGIN and restores it after acknowledged COMMIT',
    async idle => {
      const fixture = await postgresPeer(true, { idle })
      await expect(
        withTransaction(async () => 'committed', fixture.pool, {
          signal: new AbortController().signal,
        })
      ).resolves.toBe('committed')
      expect(fixture.sessionChanges).toEqual([
        { sql: settingSql, values: ['idle_in_transaction_session_timeout', '15000'] },
        { sql: settingSql, values: ['idle_in_transaction_session_timeout', idle] },
      ])
      expect(fixture.queries.indexOf(settingSql)).toBeLessThan(fixture.queries.indexOf('BEGIN'))
      expect(fixture.queries.lastIndexOf(settingSql)).toBeGreaterThan(
        fixture.queries.indexOf('COMMIT')
      )
      expect(fixture.pool.totalCount).toBe(1)
      expect(fixture.pool.idleCount).toBe(1)
      const inspected = await fixture.pool.query(
        "SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'"
      )
      expect(inspected.rows[0].idle_timeout_ms).toBe(idle)
    }
  )

  it('preserves a smaller positive server idle limit without changing the session', async () => {
    const fixture = await postgresPeer(true, { idle: '300' })
    await expect(
      withTransaction(async () => 'committed', fixture.pool, {
        signal: new AbortController().signal,
      })
    ).resolves.toBe('committed')
    expect(fixture.sessionChanges).toEqual([])
    expect(fixture.pool.idleCount).toBe(1)
  })

  it.each(['0', '99', '30001', 'not-a-number', null])(
    'fails before BEGIN for effective statement timeout %s and physically evicts the checkout',
    async statement => {
      const fixture = await postgresPeer(true, { statement })
      const work = vi.fn()
      const removed = vi.fn()
      fixture.pool.on('remove', removed)
      await expect(
        withTransaction(work, fixture.pool, { signal: new AbortController().signal })
      ).rejects.toThrow('Invalid effective PostgreSQL cancellation timeout bounds')
      expect(work).not.toHaveBeenCalled()
      expect(fixture.queries).toHaveLength(1)
      expect(fixture.queries).not.toContain('BEGIN')
      expect(fixture.pool.totalCount).toBe(0)
      expect(removed).toHaveBeenCalledOnce()
      expect(fixture.lifecycle).toEqual(['end', 'remove'])
    }
  )

  it('restores the session after acknowledged ROLLBACK without replacing the primary work error', async () => {
    const fixture = await postgresPeer()
    const primary = new Error('work failed')
    await expect(
      withTransaction(
        async () => {
          throw primary
        },
        fixture.pool,
        { signal: new AbortController().signal }
      )
    ).rejects.toBe(primary)
    expect(fixture.queries.indexOf('ROLLBACK')).toBeLessThan(
      fixture.queries.lastIndexOf(settingSql)
    )
    expect(fixture.sessionChanges.at(-1)?.values).toEqual([
      'idle_in_transaction_session_timeout',
      '0',
    ])
    expect(fixture.pool.idleCount).toBe(1)
  })

  it('poisons and physically ends a failed session setup without running work', async () => {
    const fixture = await postgresPeer()
    fixture.fail(settingSql)
    const work = vi.fn()
    const removed = vi.fn()
    fixture.pool.on('remove', removed)
    await expect(
      withTransaction(work, fixture.pool, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: '42704' })
    expect(work).not.toHaveBeenCalled()
    expect(fixture.queries).not.toContain('BEGIN')
    expect(fixture.sessionChanges).toHaveLength(1)
    expect(fixture.pool.totalCount).toBe(0)
    expect(removed).toHaveBeenCalledOnce()
    expect(fixture.lifecycle).toEqual(['end', 'remove'])
  })

  it('evicts a failed restoration while preserving the acknowledged COMMIT outcome', async () => {
    const fixture = await postgresPeer()
    fixture.fail(settingSql, 2)
    const removed = vi.fn()
    fixture.pool.on('remove', removed)
    await expect(
      withTransaction(async () => 'committed', fixture.pool, {
        signal: new AbortController().signal,
      })
    ).resolves.toBe('committed')
    expect(fixture.queries).toContain('COMMIT')
    expect(fixture.queries).not.toContain('ROLLBACK')
    expect(fixture.pool.totalCount).toBe(0)
    expect(removed).toHaveBeenCalledOnce()
    expect(fixture.lifecycle).toEqual(['end', 'remove'])
    await expect(withTransaction(async () => 'recovered', fixture.pool)).resolves.toBe('recovered')
  })

  // Review 5426789128: an abort after the COMMIT reply arrived must not
  // relabel the committed result as a cancellation.
  it('keeps an acknowledged COMMIT when the signal aborts as its reply resolves', async () => {
    const fixture = await postgresPeer()
    const controller = new AbortController()
    const reason = interruption('authorize_timeout')
    fixture.pool.once('acquire', client => {
      const query = client.query.bind(client) as (text: string) => Promise<unknown>
      vi.spyOn(client, 'query').mockImplementation(((text: string, ...rest: unknown[]) => {
        const reply = (query as (...args: unknown[]) => Promise<unknown>)(text, ...rest)
        // Abort in the continuation of the acknowledged COMMIT, before the
        // transaction helper resumes.
        return text === 'COMMIT'
          ? reply.then(result => {
              controller.abort(reason)
              return result
            })
          : reply
      }) as never)
    })
    const outcome = withTransaction(async () => 'committed', fixture.pool, {
      signal: controller.signal,
    })
    await expect(within(outcome)).resolves.toBe('committed')
    // Witness: the abort did land, after COMMIT was acknowledged.
    expect(controller.signal.aborted).toBe(true)
    expect(fixture.queries).toContain('COMMIT')
    expect(fixture.queries).not.toContain('ROLLBACK')
    // The aborted session is evicted, not restored to the pool.
    expect(fixture.sessionChanges).toHaveLength(1)
    expect(fixture.pool.totalCount).toBe(0)
  })

  it('keeps an acknowledged COMMIT when the signal aborts during session restoration', async () => {
    const fixture = await postgresPeer()
    fixture.stall(settingSql, 2)
    const controller = new AbortController()
    const outcome = withTransaction(async () => 'committed', fixture.pool, {
      signal: controller.signal,
    })
    await observed(() => fixture.sessionChanges.length === 2)
    // Witness: COMMIT was acknowledged and the restoration is in flight.
    expect(fixture.queries.indexOf('COMMIT')).toBeLessThan(fixture.queries.lastIndexOf(settingSql))
    controller.abort(interruption('authorize_aborted'))
    await expect(within(outcome)).resolves.toBe('committed')
    expect(fixture.queries).not.toContain('ROLLBACK')
    expect(fixture.pool.totalCount).toBe(0)
  })

  it('evicts a failed restoration after ROLLBACK and keeps the original work failure', async () => {
    const fixture = await postgresPeer()
    fixture.fail(settingSql, 2)
    const primary = new Error('work failed')
    await expect(
      withTransaction(
        async () => {
          throw primary
        },
        fixture.pool,
        { signal: new AbortController().signal }
      )
    ).rejects.toBe(primary)
    expect(fixture.queries).toContain('ROLLBACK')
    expect(fixture.pool.totalCount).toBe(0)
    expect(fixture.lifecycle).toEqual(['end', 'remove'])
  })

  it('retains the sole pool checkout until restoration finishes before serving the next borrower', async () => {
    const fixture = await postgresPeer()
    fixture.stall(settingSql, 2)
    let settled = false
    const first = withTransaction(async () => 'first', fixture.pool, {
      signal: new AbortController().signal,
    }).finally(() => {
      settled = true
    })
    await observed(() => fixture.sessionChanges.length === 2)
    const borrowed = (fixture.pool as unknown as { _clients: PoolClient[] })._clients[0]
    const release = vi.spyOn(borrowed, 'release')
    const next = withTransaction(async () => 'next', fixture.pool)
    await observed(() => fixture.pool.waitingCount === 1)
    expect(settled).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(fixture.pool.totalCount).toBe(1)
    fixture.resume()
    await expect(first).resolves.toBe('first')
    await expect(next).resolves.toBe('next')
    expect(fixture.pool.totalCount).toBe(1)
    expect(fixture.pool.idleCount).toBe(1)
  })
})
