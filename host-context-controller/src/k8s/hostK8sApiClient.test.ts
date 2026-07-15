import { afterEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import * as http from 'node:http'
import {
  HOST_K8S_REQUEST_TIMEOUT_CODE,
  HostK8sRequestTimeoutError,
  withHostK8sRequestDeadline,
} from './hostK8sApiClient'

const servers: http.Server[] = []

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('local test server did not expose a TCP address')
  }
  return `http://127.0.0.1:${address.port}`
}

function clientFor(baseUrl: string, timeoutMs: number): k8s.CoreV1Api {
  const rawClient = new k8s.CoreV1Api(
    k8s.createConfiguration({ baseServer: new k8s.ServerConfiguration(baseUrl, {}) })
  )
  return withHostK8sRequestDeadline(rawClient, timeoutMs)
}

function respond(res: http.ServerResponse, name: string): void {
  const body = JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } })
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function observable<T>(value: T): k8s.Observable<T> {
  return new k8s.Observable(Promise.resolve(value))
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('withHostK8sRequestDeadline', () => {
  it('allows a normal request to complete before its deadline', async () => {
    const baseUrl = await startServer((_req, res) => respond(res, 'normal'))
    const namespace = await clientFor(baseUrl, 1_000).readNamespace({ name: 'normal' })
    expect(namespace.metadata?.name).toBe('normal')
  })

  it('aborts a hung transport request and rejects with an identifiable timeout', async () => {
    let requestContext: k8s.RequestContext | undefined
    let socketClosed = false
    let markRequestSeen!: () => void
    const requestSeen = new Promise<void>(resolve => {
      markRequestSeen = resolve
    })
    const baseUrl = await startServer((_req, res) => {
      res.once('close', () => {
        socketClosed = true
      })
      markRequestSeen()
    })
    const captureMiddleware: k8s.ObservableMiddleware = {
      pre: context => {
        requestContext = context
        return observable(context)
      },
      post: context => observable(context),
    }
    const startedAt = Date.now()
    const request = clientFor(baseUrl, 80).readNamespace(
      { name: 'hung' },
      { middleware: [captureMiddleware] }
    )

    await requestSeen
    await expect(request).rejects.toMatchObject({
      name: 'HostK8sRequestTimeoutError',
      code: HOST_K8S_REQUEST_TIMEOUT_CODE,
      timeoutMs: 80,
    })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(requestContext?.getSignal()?.aborted).toBe(true)
    await vi.waitFor(() => expect(socketClosed).toBe(true))
  })

  it('starts a fresh deadline for every request rather than timing the whole sequence', async () => {
    const baseUrl = await startServer((req, res) =>
      respond(res, req.url?.split('/').pop() || 'unknown')
    )
    const client = clientFor(baseUrl, 80)
    const startedAt = Date.now()

    const first = await client.readNamespace({ name: 'first' })
    await new Promise(resolve => setTimeout(resolve, 120))
    const second = await client.readNamespace({ name: 'second' })

    expect(first.metadata?.name).toBe('first')
    expect(second.metadata?.name).toBe('second')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
  })

  it('combines caller cancellation with the deadline without misclassifying it', async () => {
    let markRequestSeen!: () => void
    const requestSeen = new Promise<void>(resolve => {
      markRequestSeen = resolve
    })
    const baseUrl = await startServer((_req, _res) => markRequestSeen())
    const caller = new AbortController()
    const callerSignalMiddleware: k8s.ObservableMiddleware = {
      pre: context => {
        context.setSignal(caller.signal)
        return observable(context)
      },
      post: context => observable(context),
    }
    const request = clientFor(baseUrl, 1_000).readNamespace(
      { name: 'cancelled' },
      { middleware: [callerSignalMiddleware] }
    )

    await requestSeen
    caller.abort(new Error('caller cancelled'))

    let thrown: unknown
    try {
      await request
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(HostK8sRequestTimeoutError)
  })

  it('keeps timeout classification when caller cancellation follows the deadline', async () => {
    let markRequestSeen!: () => void
    const requestSeen = new Promise<void>(resolve => {
      markRequestSeen = resolve
    })
    const baseUrl = await startServer((_req, _res) => markRequestSeen())
    const caller = new AbortController()
    const callerSignalMiddleware: k8s.ObservableMiddleware = {
      pre: context => {
        context.setSignal(caller.signal)
        return observable(context)
      },
      post: context => observable(context),
    }
    const request = clientFor(baseUrl, 60).readNamespace(
      { name: 'race' },
      { middleware: [callerSignalMiddleware] }
    )

    await requestSeen
    await expect(request).rejects.toBeInstanceOf(HostK8sRequestTimeoutError)
    caller.abort(new Error('shutdown'))
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('does not release the caller until the aborted transport actually rejects', async () => {
    const transport = deferred<{ ok: true }>()
    let requestSignal: AbortSignal | undefined
    let markMiddlewareInstalled!: () => void
    const middlewareInstalled = new Promise<void>(resolve => {
      markMiddlewareInstalled = resolve
    })
    const rawClient = {
      probe: async (
        _request: Record<string, never>,
        options?: k8s.ConfigurationOptions<k8s.ObservableMiddleware>
      ): Promise<{ ok: true }> => {
        let context = new k8s.RequestContext('http://127.0.0.1/probe', k8s.HttpMethod.GET)
        for (const middleware of options?.middleware ?? []) {
          context = await middleware.pre(context).toPromise()
        }
        requestSignal = context.getSignal()
        markMiddlewareInstalled()
        return transport.promise
      },
    }
    const request = withHostK8sRequestDeadline(rawClient, 40).probe({})
    let settled = false
    void request.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await middlewareInstalled
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(requestSignal?.aborted).toBe(true)
    expect(settled).toBe(false)

    const transportError = new Error('transport acknowledged abort')
    transport.reject(transportError)
    await expect(request).rejects.toMatchObject({
      name: 'HostK8sRequestTimeoutError',
      cause: transportError,
    })
  })
})
