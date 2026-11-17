import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createStaticRuntimeTokenProvider } from '@clerum/workflow-runtime-core'
import { SnippetRunnerClient } from '../../../src/workflow/snippetRunnerClient'
import { createSnippetRunnerServer } from '../../../src/workflow/snippetRunnerServer'

describe('SnippetRunnerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('rereads token provider and uses a fresh abort signal after a 401 response', async () => {
    const provider = {
      getSnippetRunnerToken: vi.fn().mockResolvedValueOnce('jwt-a').mockResolvedValueOnce('jwt-b'),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"error":"unauthorized"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"stepId":"s1","status":"completed","output":"ok"}',
      })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SnippetRunnerClient('http://snippet-runner:8095', provider)
    const result = await client.execute({
      workflowName: 'wf',
      stepId: 's1',
      previousOutputs: {},
    })

    expect(result).toEqual({ stepId: 's1', status: 'completed', output: 'ok' })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-a')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-b')
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
    expect(fetchMock.mock.calls[1][1].signal).toBeDefined()
    expect(fetchMock.mock.calls[1][1].signal).not.toBe(fetchMock.mock.calls[0][1].signal)
  })

  it('returns a timeout failure when the snippet runner request aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      })
    )
    vi.useFakeTimers()

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' }),
      100
    )
    const pending = client.execute({
      workflowName: 'wf',
      stepId: 's1',
      previousOutputs: {},
    })

    await vi.advanceTimersByTimeAsync(100)
    const result = await pending

    expect(result).toEqual({
      stepId: 's1',
      status: 'failed',
      error: 'snippet runner request timed out',
    })
  })

  it('uses declared snippet timeoutSeconds instead of the static fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      })
    )
    vi.useFakeTimers()

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' }),
      100_000
    )
    const pending = client.execute({
      workflowName: 'wf',
      stepId: 's1',
      previousOutputs: {},
      timeoutSeconds: 1,
    })

    await vi.advanceTimersByTimeAsync(6000)
    const result = await pending

    expect(result.status).toBe('failed')
    expect(result.error).toBe('snippet runner request timed out')
  })

  it('reports healthy from GET /health without reading the runner token', async () => {
    const provider = { getSnippetRunnerToken: vi.fn().mockResolvedValue('jwt-a') }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SnippetRunnerClient('http://snippet-runner:8095', provider)
    const result = await client.healthCheck()

    expect(result).toEqual({ status: 'healthy' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://snippet-runner:8095/health')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeDefined()
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined()
    expect(provider.getSnippetRunnerToken).not.toHaveBeenCalled()
  })

  it('reports unhealthy when GET /health returns a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' })
    )

    await expect(client.healthCheck()).resolves.toEqual({ status: 'unhealthy' })
  })

  it('reports unhealthy when GET /health cannot connect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' })
    )

    await expect(client.healthCheck()).resolves.toEqual({ status: 'unhealthy' })
  })

  it('reports unhealthy when GET /health does not answer within 5 seconds', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      })
    )
    vi.useFakeTimers()

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' })
    )
    let settled = false
    const pending = client.healthCheck().then(result => {
      settled = true
      return result
    })

    await vi.advanceTimersByTimeAsync(4999)
    expect(signal).toBeDefined()
    expect(settled).toBe(false)
    expect(signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'unhealthy' })
    expect(signal?.aborted).toBe(true)
  })

  it('releases the connection when GET /health sends headers but never finishes the body', async () => {
    const sockets = new Set<Socket>()
    let resolveHealthSocketClosed: () => void = () => {}
    const healthSocketClosed = new Promise<void>(resolve => {
      resolveHealthSocketClosed = resolve
    })
    const server = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404)
        res.end()
        return
      }
      req.socket.once('close', () => resolveHealthSocketClosed())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"status":')
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const { port } = server.address() as AddressInfo
      const client = new SnippetRunnerClient(
        `http://127.0.0.1:${port}`,
        createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' })
      )

      await expect(client.healthCheck()).resolves.toEqual({ status: 'healthy' })
      await Promise.race([
        healthSocketClosed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('GET /health connection was not released within 1 s')),
            1000
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('SnippetRunnerClient health check against the snippet runner server', () => {
  let tokenDir: string
  let outputDir: string

  beforeEach(async () => {
    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-token-'))
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-output-'))
    const tokenPath = path.join(tokenDir, 'token')
    await fs.writeFile(tokenPath, 'runner-token\n', 'utf8')
    vi.stubEnv('SNIPPET_RUNNER_TOKEN_FILE', tokenPath)
    vi.stubEnv('CLERUM_WORKFLOW_OUTPUT_DIR', outputDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(tokenDir, { recursive: true, force: true })
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  it('reports healthy from the runner server and unhealthy under a wrong base URL', async () => {
    const server = createSnippetRunnerServer()
    const received: string[] = []
    server.on('request', req => received.push(`${req.method} ${req.url}`))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const tokenProvider = createStaticRuntimeTokenProvider({ snippetRunnerToken: 'runner-token' })

      await expect(
        new SnippetRunnerClient(`http://127.0.0.1:${port}`, tokenProvider).healthCheck()
      ).resolves.toEqual({ status: 'healthy' })
      await expect(
        new SnippetRunnerClient(`http://127.0.0.1:${port}/wrong`, tokenProvider).healthCheck()
      ).resolves.toEqual({ status: 'unhealthy' })
      // Liveness witness: both probes reached this server, so the unhealthy verdict is its
      // 404 for an unknown route, not a refused connection.
      expect(received).toEqual(['GET /health', 'GET /wrong/health'])
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
