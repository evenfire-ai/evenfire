// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EventEmitter } from 'node:events'
import {
  closeActiveEntityChangeStreams,
  streamEntityChanges,
} from '../../../control-api/src/routes/entityChangeStream.js'
import { GfsBrowser } from '../GfsBrowser'
import { ToastProvider } from '../Toast'

const controlApiProducer = vi.hoisted(() => ({
  isEntityChangeCursor: vi.fn(),
  readEntityChangeCheckpoint: vi.fn(),
  subscribeEntityChangeFeedWake: vi.fn(),
}))
const controlApiProducerConfig = vi.hoisted(() => ({
  entityChangeStreamHeartbeatMs: 20_000,
  entityChangeStreamMaxLifetimeMs: 600_000,
  entityChangeStreamPollMs: 250,
  entityChangeUserVisibilityRefreshMs: 4_000,
  entityChangeStreamMaxConnections: 256,
  entityChangeStreamMaxConnectionsPerPrincipal: 32,
}))
const controlApiProducerMetrics = vi.hoisted(() => ({
  entityChangeStreamConnectionsActive: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamDisconnectsTotal: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamFramesSentTotal: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamResyncRequiredTotal: { inc: vi.fn(), dec: vi.fn() },
}))

vi.mock('../../../control-api/src/config.js', () => ({ config: controlApiProducerConfig }))
vi.mock('../../../control-api/src/db.js', () => ({ pool: {} }))
vi.mock('../../../control-api/src/services/entityChangeService.js', () => controlApiProducer)
vi.mock('../../../control-api/src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../../control-api/src/observability/metrics.js', () => controlApiProducerMetrics)

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function child(resourceId: string, rid: string, name: string, kind: string) {
  return {
    resourceId,
    rid,
    gfsUri: `gfs://main/${rid}`,
    name,
    kind,
    path: `/${name}`,
    bytes: 0,
    version: 1,
  }
}

class ProducerRequest extends EventEmitter {
  query: Record<string, unknown> = {}
  setTimeout = vi.fn()
}

class ProducerResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  destroyed = false
  writableEnded = false
  writableLength = 0
  headers: Record<string, string> = {}
  jsonBody: unknown
  frames: string[] = []
  status(code: number): this {
    this.statusCode = code
    return this
  }
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }
  flushHeaders(): void {
    this.headersSent = true
  }
  write(frame: string): boolean {
    this.frames.push(frame)
    return true
  }
  end(): void {
    this.writableEnded = true
    this.emit('close')
  }
  json(value: unknown): this {
    this.jsonBody = value
    this.headersSent = true
    return this
  }
}

async function controlApiCapacityResponse(): Promise<Response> {
  const previousLimit = controlApiProducerConfig.entityChangeStreamMaxConnections
  controlApiProducerConfig.entityChangeStreamMaxConnections = 0
  const req = new ProducerRequest()
  const res = new ProducerResponse()
  try {
    streamEntityChanges(req as never, res as never, null, async () => true, 'operator')
    await vi.waitFor(() => expect(res.statusCode).toBe(429))
  } finally {
    controlApiProducerConfig.entityChangeStreamMaxConnections = previousLimit
  }
  return new Response(JSON.stringify(res.jsonBody), {
    status: res.statusCode,
    headers: res.headers,
  })
}

async function controlApiProducerFrame(): Promise<string> {
  const cursor = 'd119f895-1ef8-4e73-8f08-f9754919682a'
  controlApiProducer.isEntityChangeCursor.mockImplementation((value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
  controlApiProducer.readEntityChangeCheckpoint.mockResolvedValue({
    resyncRequired: false,
    cursor,
    scopes: ['gfs'],
  })
  controlApiProducer.subscribeEntityChangeFeedWake.mockReturnValue(vi.fn())
  const req = new ProducerRequest()
  const res = new ProducerResponse()
  streamEntityChanges(
    req as never,
    res as never,
    null,
    async () => true,
    'operator',
    'control-ui-integration'
  )
  await vi.waitFor(() => expect(res.frames.length).toBeGreaterThan(0))
  const frame = res.frames
    .map(value => value.trim())
    .find(value => (JSON.parse(value) as { type?: string }).type === 'scope.invalidated')
  closeActiveEntityChangeStreams()
  await vi.waitFor(() => expect(res.writableEnded).toBe(true))
  if (!frame) throw new Error('Control API producer did not emit a scope invalidation')
  return frame
}

describe('GfsBrowser authoritative revalidation integration', () => {
  afterEach(() => {
    cleanup()
    closeActiveEntityChangeStreams()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('honors the Control API Retry-After when an operator stream is rate limited', async () => {
    const rateLimitedResponse = await controlApiCapacityResponse()
    const scheduledTimers = vi.spyOn(window, 'setTimeout')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let streamAttempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://control-ui.test')
        if (url.pathname.endsWith('/api/v1/gfs/entity-changes/stream')) {
          streamAttempts += 1
          if (streamAttempts === 1) return rateLimitedResponse
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
              },
            }),
            { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
          )
        }
        if (url.pathname.endsWith('/api/v1/gfs/tree')) {
          return jsonResponse({ rootResourceId: 'root-1', items: [], nextCursor: null })
        }
        if (url.pathname.endsWith('/api/v1/gfs/resources/root-1/children')) {
          return jsonResponse({
            items: [child('file-1', 'rid-file-1', 'kept.txt', 'file')],
            nextCursor: null,
          })
        }
        return jsonResponse({ items: [], nextCursor: null })
      })
    )

    render(
      <ToastProvider>
        <GfsBrowser />
      </ToastProvider>
    )
    await screen.findByRole('button', { name: 'kept.txt' })
    await waitFor(() =>
      expect(scheduledTimers.mock.calls.some(([, delay]) => delay === 5000)).toBe(true)
    )
    expect(streamAttempts).toBe(1)
    expect(screen.getByRole('button', { name: 'kept.txt' })).toBeVisible()
  })

  it.each(['scope.invalidated', 'resync_required'] as const)(
    'does not publish a stale background page after %s',
    async frameType => {
      const work = child('folder-1', 'rid-folder-1', 'work', 'directory')
      const staleRow = child('stale-file', 'rid-stale', 'stale.txt', 'file')
      const currentRow = child('current-file', 'rid-current', 'current.txt', 'file')
      const folderPath = '/control-api/api/v1/gfs/resources/folder-1/children'
      const stalePage = { items: [staleRow], nextCursor: null }
      const currentPage = { items: [currentRow], nextCursor: null }
      let finishStaleRead!: (response: Response) => void
      const staleRead = new Promise<Response>(resolve => {
        finishStaleRead = resolve
      })
      let childReads = 0
      let folderOpened = false
      let staleBackgroundStarted = false
      const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input), 'http://control-ui.test')
          if (url.pathname.endsWith('/api/v1/gfs/entity-changes/stream')) {
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                streamControllers.push(controller)
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
              },
            })
            return new Response(body, {
              status: 200,
              headers: { 'content-type': 'application/x-ndjson' },
            })
          }
          if (url.pathname.endsWith('/api/v1/gfs/tree')) {
            return jsonResponse({
              rootResourceId: 'root-1',
              items: [work],
              nextCursor: null,
            })
          }
          if (url.pathname === '/control-api/api/v1/gfs/resources/root-1/children') {
            return jsonResponse({ items: [work], nextCursor: null })
          }
          if (url.pathname === folderPath) {
            childReads += 1
            if (!folderOpened) return jsonResponse(stalePage)
            if (!staleBackgroundStarted) {
              staleBackgroundStarted = true
              return staleRead
            }
            return jsonResponse(currentPage)
          }
          if (url.pathname.endsWith('/api/v1/gfs/resolve')) {
            return jsonResponse({
              resourceId: 'folder-1',
              rid: 'rid-folder-1',
              gfsUri: 'gfs://main/rid-folder-1',
              name: 'work',
              kind: 'directory',
              path: '/work',
              version: 1,
            })
          }
          if (url.pathname.endsWith('/api/v1/gfs/by-path')) {
            return jsonResponse({
              resourceId: 'folder-1',
              rid: 'rid-folder-1',
              gfsUri: 'gfs://main/rid-folder-1',
              name: 'work',
              kind: 'directory',
              path: '/work',
              version: 1,
            })
          }
          return jsonResponse({ items: [], nextCursor: null })
        })
      )

      render(
        <ToastProvider>
          <GfsBrowser />
        </ToastProvider>
      )
      await waitFor(() => expect(streamControllers).toHaveLength(1))
      await screen.findByRole('button', { name: 'work' })
      fireEvent.click(screen.getByRole('button', { name: 'work' }))
      await screen.findByRole('button', { name: 'stale.txt' })
      const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
      fireEvent.click(breadcrumb.querySelector('button')!)
      await screen.findByRole('button', { name: 'work' })
      folderOpened = true
      fireEvent.click(screen.getByRole('button', { name: 'work' }))
      await screen.findByRole('button', { name: 'stale.txt' })
      await waitFor(() => expect(staleBackgroundStarted).toBe(true))

      await act(async () => {
        streamControllers[0]!.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({
              schemaVersion: 1,
              type: frameType,
              cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a',
              scopes: ['gfs'],
            })}\n`
          )
        )
      })
      await screen.findByRole('button', { name: 'current.txt' })
      await waitFor(() => expect(childReads).toBeGreaterThan(2))

      await act(async () => finishStaleRead(jsonResponse(stalePage)))
      await waitFor(() => expect(screen.getByRole('button', { name: 'current.txt' })).toBeVisible())
      expect(screen.queryByRole('button', { name: 'stale.txt' })).toBeNull()
    }
  )

  it('keeps all loaded pages visible while a scope invalidation revalidates them', async () => {
    const work = child('folder-1', 'rid-folder-1', 'work', 'directory')
    const first = child('file-1', 'rid-file-1', 'first.txt', 'file')
    const second = child('file-2', 'rid-file-2', 'second.txt', 'file')
    const folderPath = '/control-api/api/v1/gfs/resources/folder-1/children'
    let finishRefresh!: (response: Response) => void
    const refresh = new Promise<Response>(resolve => {
      finishRefresh = resolve
    })
    let folderPageReads = 0
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://control-ui.test')
        if (url.pathname.endsWith('/api/v1/gfs/entity-changes/stream')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
              },
            }),
            { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
          )
        }
        if (url.pathname.endsWith('/api/v1/gfs/tree')) {
          return jsonResponse({ rootResourceId: 'root-1', items: [work], nextCursor: null })
        }
        if (url.pathname === '/control-api/api/v1/gfs/resources/root-1/children') {
          return jsonResponse({ items: [work], nextCursor: null })
        }
        if (url.pathname === folderPath) {
          const cursor = url.searchParams.get('cursor')
          if (cursor) return jsonResponse({ items: [second], nextCursor: null })
          folderPageReads += 1
          if (folderPageReads === 1) return jsonResponse({ items: [first], nextCursor: 'page-2' })
          return refresh
        }
        if (
          url.pathname.endsWith('/api/v1/gfs/resolve') ||
          url.pathname.endsWith('/api/v1/gfs/by-path')
        ) {
          return jsonResponse({
            resourceId: 'folder-1',
            rid: 'rid-folder-1',
            gfsUri: 'gfs://main/rid-folder-1',
            name: 'work',
            kind: 'directory',
            path: '/work',
            version: 1,
          })
        }
        return jsonResponse({ items: [], nextCursor: null })
      })
    )

    render(
      <ToastProvider>
        <GfsBrowser />
      </ToastProvider>
    )
    await waitFor(() => expect(streamController).not.toBeNull())
    await screen.findByRole('button', { name: 'work' })
    await waitFor(() => expect(folderPageReads).toBe(1))
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    fireEvent.click(screen.getByRole('button', { name: 'work' }))
    await screen.findByRole('button', { name: 'first.txt' })
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('button', { name: 'second.txt' })

    await act(async () => {
      streamController!.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({
            schemaVersion: 1,
            type: 'scope.invalidated',
            cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a',
            scopes: ['gfs'],
          })}\n`
        )
      )
    })
    await waitFor(() => expect(folderPageReads).toBeGreaterThan(1))
    expect(screen.getByRole('button', { name: 'first.txt' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'second.txt' })).toBeVisible()

    await act(async () => finishRefresh(jsonResponse({ items: [first], nextCursor: 'page-2' })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'second.txt' })).toBeVisible())
    expect(screen.getByRole('button', { name: 'first.txt' })).toBeVisible()
  })

  it('recovers the rendered list after a real API-client stream refresh fails once', async () => {
    const existingFile = child('file-1', 'rid-file-1', 'existing.txt', 'file')
    const remoteFolder = child('folder-2', 'rid-folder-2', 'remote-folder', 'directory')
    let rootChildReads = 0
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://control-ui.test')
        if (url.pathname.endsWith('/api/v1/gfs/entity-changes/stream')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
              },
            }),
            { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
          )
        }
        if (url.pathname.endsWith('/api/v1/gfs/tree')) {
          return jsonResponse({ rootResourceId: 'root-1', items: [], nextCursor: null })
        }
        if (url.pathname.endsWith('/api/v1/gfs/resources/root-1/children')) {
          rootChildReads += 1
          if (rootChildReads === 1) {
            return jsonResponse({ items: [existingFile], nextCursor: null })
          }
          if (rootChildReads === 2) return new Response('temporary failure', { status: 503 })
          return jsonResponse({
            items: [existingFile, remoteFolder],
            nextCursor: null,
          })
        }
        return jsonResponse({ items: [], nextCursor: null })
      })
    )

    render(
      <ToastProvider>
        <GfsBrowser />
      </ToastProvider>
    )
    await waitFor(() => expect(streamController).not.toBeNull())
    await screen.findByRole('button', { name: 'existing.txt' })
    await act(async () => {
      streamController!.enqueue(new TextEncoder().encode(`${await controlApiProducerFrame()}\n`))
    })

    await waitFor(() => expect(rootChildReads).toBe(2))
    expect(screen.getByRole('button', { name: 'existing.txt' })).toBeVisible()
    await screen.findByText('remote-folder', {}, { timeout: 2_000 })
    expect(rootChildReads).toBe(3)
    expect(screen.getByRole('button', { name: 'existing.txt' })).toBeVisible()
  })

  it('preserves the complete folder trail when an ancestor lookup fails', async () => {
    const work = child('folder-1', 'rid-folder-1', 'work', 'directory')
    const existingFile = child('file-1', 'rid-file-1', 'existing.txt', 'file')
    let byPathReads = 0
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://control-ui.test')
        if (url.pathname.endsWith('/api/v1/gfs/entity-changes/stream')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
              },
            }),
            { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
          )
        }
        if (url.pathname.endsWith('/api/v1/gfs/tree')) {
          return jsonResponse({ rootResourceId: 'root-1', items: [work], nextCursor: null })
        }
        if (url.pathname.endsWith('/api/v1/gfs/resources/root-1/children')) {
          return jsonResponse({ items: [work], nextCursor: null })
        }
        if (url.pathname.endsWith('/api/v1/gfs/resources/folder-1/children')) {
          return jsonResponse({ items: [existingFile], nextCursor: null })
        }
        if (url.pathname.endsWith('/api/v1/gfs/resolve')) {
          return jsonResponse({
            resourceId: work.resourceId,
            rid: work.rid,
            gfsUri: work.gfsUri,
            name: work.name,
            kind: 'directory',
            path: '/work',
            version: work.version,
          })
        }
        if (url.pathname.endsWith('/api/v1/gfs/by-path')) {
          byPathReads += 1
          if (byPathReads === 1)
            return new Response('ancestor temporarily unavailable', { status: 409 })
          return jsonResponse({
            resourceId: work.resourceId,
            rid: work.rid,
            gfsUri: work.gfsUri,
            name: work.name,
            kind: 'directory',
            path: '/work',
            version: work.version,
          })
        }
        return jsonResponse({ items: [], nextCursor: null })
      })
    )

    render(
      <ToastProvider>
        <GfsBrowser />
      </ToastProvider>
    )
    await waitFor(() => expect(streamController).not.toBeNull())
    await screen.findByRole('button', { name: 'work' })
    fireEvent.click(screen.getByRole('button', { name: 'work' }))
    await screen.findByRole('button', { name: 'existing.txt' })

    await act(async () => {
      streamController!.enqueue(new TextEncoder().encode(`${await controlApiProducerFrame()}\n`))
    })

    await waitFor(() => expect(byPathReads).toBe(1))
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    await waitFor(() =>
      expect(within(breadcrumb).getByRole('button', { name: 'work' })).toHaveAttribute(
        'aria-current',
        'page'
      )
    )
    expect(screen.getByRole('button', { name: 'existing.txt' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry folder path' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(within(breadcrumb).getByRole('button', { name: 'work' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('button', { name: 'existing.txt' })).toBeVisible()
  })
})
