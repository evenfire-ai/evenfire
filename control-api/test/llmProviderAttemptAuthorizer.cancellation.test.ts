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

async function postgresPeer(handshake = true) {
  const connected = deferred()
  const queries: string[] = []
  const sockets = new Set<Socket>()
  let stalledSql = ''
  let failedSql = ''
  const server = createTcpServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    connected.resolve()
    let startup = true
    let buffered = Buffer.alloc(0)
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
        if (type !== 'Q') continue
        const sql = body.toString('utf8', 0, body.length - 1)
        queries.push(sql)
        if (sql === failedSql) {
          socket.write(
            Buffer.concat([
              protocolMessage(
                'E',
                Buffer.from('SERROR\0C42704\0Munsupported connection check parameter\0\0')
              ),
              protocolMessage('Z', Buffer.from('E')),
            ])
          )
          continue
        }
        if (sql === stalledSql) continue
        socket.write(
          Buffer.concat([
            protocolMessage('C', Buffer.from(`${sql.split(' ')[0]}\0`)),
            protocolMessage('Z', Buffer.from(sql === 'BEGIN' ? 'T' : 'I')),
          ])
        )
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
    pool,
    stall: (sql: string) => {
      stalledSql = sql
    },
    fail: (sql: string) => {
      failedSql = sql
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
      'BEGIN',
      "SET LOCAL client_connection_check_interval = '100ms'",
      'ROLLBACK',
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
      'BEGIN',
      "SET LOCAL client_connection_check_interval = '100ms'",
      'COMMIT',
    ])
    expect(fixture.pool.totalCount).toBe(0)
  })
})
