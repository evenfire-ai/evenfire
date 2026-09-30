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
const producerConfig = vi.hoisted(() => ({
  entityChangeStreamHeartbeatMs: 20_000,
  entityChangeStreamMaxLifetimeMs: 600_000,
  entityChangeStreamPollMs: 250,
  entityChangeUserVisibilityRefreshMs: 4_000,
  entityChangeStreamMaxConnections: 256,
  entityChangeStreamMaxConnectionsPerPrincipal: 32,
}))
const producerMetrics = vi.hoisted(() => ({
  entityChangeStreamConnectionsActive: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamDisconnectsTotal: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamFramesSentTotal: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamResyncRequiredTotal: { inc: vi.fn(), dec: vi.fn() },
}))

vi.mock('../../../control-api/src/config.js', () => ({ config: producerConfig }))
vi.mock('../../../control-api/src/db.js', () => ({ pool: {} }))
vi.mock('../../../control-api/src/services/entityChangeService.js', () => controlApiProducer)
vi.mock('../../../control-api/src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../../control-api/src/observability/metrics.js', () => producerMetrics)

const ROOT_ID = '11111111-1111-1111-1111-111111111111'
const ROOT_RID = '11111111111111111111111111111111'
const CURSOR = 'd119f895-1ef8-4e73-8f08-f9754919682a'

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
  frames: string[] = []
  status(code: number): this {
    this.statusCode = code
    return this
  }
  setHeader(): void {}
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
  json(): this {
    return this
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('GfsBrowser foreground/stream arbitration integration', () => {
  afterEach(() => {
    cleanup()
    closeActiveEntityChangeStreams()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('cancels a stale stream read when a foreground mutation refreshes the same folder', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let wakeFeed: (() => void) | null = null
    let producerResponse: ProducerResponse | null = null
    let childReads = 0
    let staleReadSignal: AbortSignal | null = null
    const existingFile = {
      resourceId: '22222222-2222-2222-2222-222222222222',
      rid: '22222222222222222222222222222222',
      gfsUri: 'gfs://main/22222222222222222222222222222222',
      name: 'existing.txt',
      kind: 'file',
      path: '/existing.txt',
      bytes: 0,
      version: 1,
    }
    const createdFolder = {
      resourceId: '33333333-3333-3333-3333-333333333333',
      rid: '33333333333333333333333333333333',
      gfsUri: 'gfs://main/33333333333333333333333333333333',
      name: 'created-after-refresh',
      kind: 'directory',
      path: '/created-after-refresh',
      bytes: 0,
      version: 1,
    }

    controlApiProducer.isEntityChangeCursor.mockImplementation((value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
    controlApiProducer.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: [],
    })
    controlApiProducer.subscribeEntityChangeFeedWake.mockImplementation((wake: () => void) => {
      wakeFeed = wake
      return vi.fn()
    })

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
          return jsonResponse({ rootResourceId: ROOT_ID, items: [], nextCursor: null })
        }
        if (url.pathname.endsWith(`/api/v1/gfs/resources/${ROOT_ID}/children`)) {
          childReads += 1
          if (childReads === 2) {
            staleReadSignal = init?.signal ?? null
            return new Promise<Response>((_resolve, reject) => {
              const rejectAborted = () => reject(new DOMException('Aborted', 'AbortError'))
              if (staleReadSignal?.aborted) {
                rejectAborted()
              } else {
                staleReadSignal?.addEventListener('abort', rejectAborted, { once: true })
              }
            })
          }
          if (childReads >= 3) {
            return jsonResponse({ items: [existingFile, createdFolder], nextCursor: null })
          }
          return jsonResponse({ items: [existingFile], nextCursor: null })
        }
        if (
          url.pathname.endsWith(
            '/api/v1/gfs/proxy/v1/resources/11111111111111111111111111111111/children'
          )
        ) {
          return jsonResponse({ ok: true })
        }
        if (url.pathname.endsWith('/api/v1/gfs/resolve')) {
          return jsonResponse({
            resourceId: ROOT_ID,
            rid: ROOT_RID,
            gfsUri: `gfs://main/${ROOT_RID}`,
            name: '/',
            kind: 'directory',
            path: '/',
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
    await screen.findByRole('button', { name: 'existing.txt' })
    await waitFor(() => expect(streamController).not.toBeNull())

    const req = new ProducerRequest()
    producerResponse = new ProducerResponse()
    streamEntityChanges(
      req as never,
      producerResponse as never,
      CURSOR,
      async () => true,
      'operator',
      'control-ui-foreground-race'
    )
    await waitFor(() => expect(producerResponse?.headersSent).toBe(true))
    controlApiProducer.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    wakeFeed?.()
    await waitFor(() =>
      expect(
        producerResponse?.frames.some(frame => frame.includes('"type":"scope.invalidated"'))
      ).toBe(true)
    )
    const changeFrame = producerResponse!.frames.find(frame =>
      frame.includes('"type":"scope.invalidated"')
    )
    expect(changeFrame).toBeDefined()
    await act(async () => {
      streamController!.enqueue(new TextEncoder().encode(changeFrame!))
    })
    await waitFor(() => expect(childReads).toBe(2))
    expect(staleReadSignal).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'created-after-refresh' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
    await screen.findByRole('button', { name: 'created-after-refresh' })

    await waitFor(() => expect(staleReadSignal?.aborted).toBe(true))
    expect(screen.getByRole('button', { name: 'created-after-refresh' })).toBeVisible()
  })
})
