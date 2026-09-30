// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsBrowser } from '../GfsBrowser'
import { ToastProvider } from '../Toast'

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

describe('GfsBrowser authoritative revalidation integration', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
})
