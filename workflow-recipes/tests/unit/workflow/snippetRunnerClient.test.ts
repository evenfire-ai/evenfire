import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createStaticRuntimeTokenProvider } from '@clerum/workflow-runtime-core'
import { SnippetRunnerClient } from '../../../src/workflow/snippetRunnerClient'

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

  it('aborts the health request after reading the status so the response body is released', async () => {
    let abortedAtCall: boolean | undefined
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      abortedAtCall = init.signal?.aborted
      return { ok: true, status: 200 }
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' })
    )
    const result = await client.healthCheck()

    expect(result).toEqual({ status: 'healthy' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(abortedAtCall).toBe(false)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted).toBe(true)
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
