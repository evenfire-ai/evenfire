import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EventSource } from 'eventsource'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('installed MCP transport close contract', () => {
  it('aborts Streamable HTTP I/O and notifies close before its promise settles', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'))
    const onclose = vi.fn()
    transport.onclose = onclose
    await transport.start()
    const controller = (
      transport as unknown as {
        _abortController?: AbortController
      }
    )._abortController

    const closing = transport.close()

    expect(controller?.signal.aborted).toBe(true)
    expect(onclose).toHaveBeenCalledOnce()
    await expect(closing).resolves.toBeUndefined()
  })

  it('synchronously detaches the real SDK Client through the transport onclose hook', async () => {
    const client = new Client(
      { name: 'transport-close-contract', version: '1.0.0' },
      { capabilities: {} }
    )
    const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      sessionId: 'existing-session',
    })
    await client.connect(transport)
    expect(client.transport).toBe(transport)

    const closing = transport.close()

    expect(client.transport).toBeUndefined()
    await expect(closing).resolves.toBeUndefined()
  })

  it('aborts SSE POST and EventSource receive I/O before its promise settles', async () => {
    const receiveStarted = deferred<AbortSignal>()
    const pendingFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error('EventSource fetch did not receive an AbortSignal'))
            return
          }
          receiveStarted.resolve(signal)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const transport = new SSEClientTransport(new URL('http://mcp.test/sse'), {
      eventSourceInit: {
        fetch: pendingFetch as typeof fetch,
      },
    })
    const onclose = vi.fn()
    transport.onclose = onclose
    const starting = transport.start()
    void starting.catch(() => undefined)
    const receiveSignal = await receiveStarted.promise
    const transportController = (
      transport as unknown as {
        _abortController?: AbortController
      }
    )._abortController
    const eventSource = (
      transport as unknown as {
        _eventSource?: EventSource
      }
    )._eventSource

    const closing = transport.close()

    expect(transportController?.signal.aborted).toBe(true)
    expect(receiveSignal.aborted).toBe(true)
    expect(eventSource?.readyState).toBe(EventSource.CLOSED)
    expect(onclose).toHaveBeenCalledOnce()
    await expect(closing).resolves.toBeUndefined()
  })
})
