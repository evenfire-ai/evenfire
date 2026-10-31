// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type Server, createServer } from 'node:http'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../src/gfs/delegation.js'
import { GfsClient } from '../../../src/gfs/uriHandler.js'
import { requestJson } from '../../../src/httpClient.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), clerum: null as any }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { isReady: () => false, on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: Handler) => electron.handlers.set(channel, handler),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => {
      electron.clerum = value
    },
  },
  ipcRenderer: {
    on: vi.fn(),
    off: vi.fn(),
    sendSync: vi.fn(),
    invoke: async (channel: string, payload: unknown) => {
      try {
        return await electron.handlers.get(channel)!(
          { senderFrame: { url: 'file:///app/index.html' } },
          payload
        )
      } catch (error) {
        throw new Error(
          `Error invoking remote method '${channel}': Error: ${(error as Error).message}`
        )
      }
    },
  },
  webUtils: { getPathForFile: vi.fn() },
}))

vi.mock('../../../src/appService.js', () => ({ AppService: class {} }))

const auth = vi.hoisted(() => ({ generation: 7 }))
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({
    isAuthenticated: true,
    sessionGeneration: auth.generation,
    me: { id: 'user-1', teamId: 'team-1' },
    runtimeConfigState: { envKey: 'test' },
  }),
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const currentUri = 'gfs://main/0123456789abcdef0123456789abcdef'
const renewedChild = childView('fresh-child-id', 'Renewed child.txt', 'file')

let generation = 7
let reads = 0
let delivered: unknown
let activeClient: GfsClient | null = null
let releaseResponse: (() => void) | null = null
const servers: Server[] = []

const service = {
  getSessionGeneration: () => generation,
  listGfsChildren: async (resourceId: string, drive?: string) => {
    reads += 1
    if (!activeClient) throw new Error('HTTP GFS client was not initialized')
    return activeClient.listChildren(resourceId, 'fixture-session-token', {
      drive: drive ?? 'main',
    })
  },
}

async function startChildServer(status: number, code: string, message: string) {
  const responseGate = deferred<void>()
  let requestCount = 0
  const server = createServer(async (_request, response) => {
    requestCount += 1
    await responseGate.promise
    if (requestCount === 1) {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code, message } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, data: await listChildrenPage([renewedChild]) }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  activeClient = new GfsClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestJson,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  releaseResponse = () => responseGate.resolve()
}

function resourceAffordances(held: string[]) {
  const client = new GfsClient({
    baseUrl: 'https://fixture.test',
    requestJson: async () => ({ held, isOperator: false }) as never,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  return client
    .affordances('folder', 'fixture-session-token', 'main')
    .then(result => delegationAffordances(new Set(result.held), result.isOperator))
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../../../src/ipc.js')
  registerIpcHandlers(service as never, async () => 0)
  await import('../../../src/preload.js')
})

afterEach(async () => {
  cleanup()
  generation = 7
  auth.generation = 7
  reads = 0
  delivered = undefined
  activeClient = null
  releaseResponse = null
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  )
})

function FilesLocationProbe() {
  const controller = useGfsBrowserController()
  return (
    <>
      <button onClick={() => void controller.openUri(currentUri)}>Open current Files folder</button>
      <div data-testid="access">{controller.accessState}</div>
      <div data-testid="location">{controller.current?.gfsUri ?? 'no-location'}</div>
    </>
  )
}

async function mount(status: number, code: string, message: string) {
  await startChildServer(status, code, message)
  const listAccessible = async () =>
    listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: async () => generation },
      gfs: {
        listAccessible,
        resolve: async () =>
          resolveResource(
            resolvedDirectory('0123456789abcdef0123456789abcdef', 'Current Files folder')
          ),
        affordances: async () => resourceAffordances(['read']),
        listChildren: async (...args: any[]) => {
          if (args[0] === '0123456789abcdef0123456789abcdef') return listChildrenPage([])
          try {
            return await electron.clerum.gfs.listChildren(...args)
          } catch (error) {
            delivered = error
            throw error
          }
        },
      },
    },
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const surface = () => (
    <QueryClientProvider client={queryClient}>
      <FileExplorerTree
        onOpenFolder={vi.fn()}
        onOpenPreview={vi.fn()}
        onResourceAction={vi.fn()}
        pushToast={vi.fn()}
      />
      <FilesLocationProbe />
    </QueryClientProvider>
  )
  const view = render(surface())
  await screen.findByRole('button', { name: 'Reports' })
  expect(screen.getByTestId('access').textContent).toBe('active')
  fireEvent.click(screen.getByRole('button', { name: 'Open current Files folder' }))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(currentUri))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => expect(reads).toBe(1))

  return {
    queryClient,
    publishRenewedGeneration: async () => {
      auth.generation = 8
      view.rerender(surface())
      await screen.findAllByRole('treeitem', { name: /Renewed child\.txt/ })
    },
  }
}

describe('FileExplorerTree expanded-folder authority handoff', () => {
  it('preserves a sibling Files location when an in-flight child 401 is stale after renewal', async () => {
    const mounted = await mount(401, 'unauthenticated', 'The previous session expired.')
    generation = 8
    releaseResponse?.()
    await waitFor(() => expect(delivered).toBeInstanceOf(Error))

    expect(delivered).toMatchObject({
      name: 'GfsStaleSessionAuthorityError',
      code: 'GFS_STALE_SESSION_AUTHORITY',
    })
    expect(screen.getByTestId('access').textContent).toBe('active')
    expect(screen.getByTestId('location').textContent).toBe(currentUri)
    expect(document.body.textContent).not.toContain('The previous session expired.')
    expect(document.body.textContent).toContain('Unable to load folder contents.')

    await mounted.publishRenewedGeneration()
    expect(screen.getByTestId('access').textContent).toBe('active')
    expect(screen.getByTestId('location').textContent).toBe(currentUri)
    expect(reads).toBe(2)
  })

  it('still revokes the current shared authority for a current-session 401', async () => {
    await mount(401, 'unauthenticated', 'Current session expired.')
    releaseResponse?.()
    await waitFor(() => expect(delivered).toBeInstanceOf(Error))
    expect(screen.getByTestId('access').textContent).toBe('revoked')
    expect(screen.getByTestId('location').textContent).toBe('no-location')
  })

  it('still revokes current typed lifecycle 403 errors', async () => {
    await mount(403, 'desktop_user_retired', 'desktop_user_retired')
    releaseResponse?.()
    await waitFor(() => expect(delivered).toBeInstanceOf(Error))
    expect(screen.getByTestId('access').textContent).toBe('revoked')
    expect(screen.getByTestId('location').textContent).toBe('no-location')
  })

  it.each([
    [
      403,
      'forbidden',
      'Private folder details must not be exposed.',
      'This folder is no longer available.',
    ],
    [
      404,
      'not_found',
      'Missing folder details must not be exposed.',
      'This folder is no longer available.',
    ],
    [
      410,
      'deleted',
      'Deleted folder details must not be exposed.',
      'Unable to load folder contents.',
    ],
    [500, 'internal_error', 'Transient server failure.', 'Unable to load folder contents.'],
  ])(
    'keeps resource-local or transient HTTP %s failures out of shared revocation',
    async (status, code, message, displayMessage) => {
      await mount(status, code, message)
      releaseResponse?.()
      await waitFor(() => expect(delivered).toBeInstanceOf(Error))
      expect(screen.getByTestId('access').textContent).toBe('active')
      expect(screen.getByTestId('location').textContent).toBe(currentUri)
      expect(document.body.textContent).not.toContain(message)
      expect(document.body.textContent).toContain(displayMessage)
    }
  )
})
