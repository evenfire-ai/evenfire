// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsDragSessionProvider } from '@/gfs/dragSession'
import { delegationAffordances } from '../../../src/gfs/delegation.js'
import { GfsClient } from '../../../src/gfs/uriHandler.js'
import { requestJson } from '../../../src/httpClient.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  clerum: null as any,
  errors: [] as string[],
}))

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
        electron.errors.push(`${channel}: ${(error as Error).message}`)
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
let releaseMoveRetryResponse: (() => void) | null = null
let releaseMoveCommitResponse: (() => void) | null = null
const servers: Server[] = []

const service = {
  getSessionGeneration: () => generation,
  listAccessibleGfsResources: async (drive?: string, cursor?: string) =>
    activeClient!.listAccessible('fixture-session-token', { drive, cursor }),
  resolveGfsUri: async (uri: string) => activeClient!.resolveUri(uri, 'fixture-session-token'),
  gfsAffordances: async (resourceId: string, drive?: string) =>
    activeClient!.affordances(resourceId, 'fixture-session-token', drive ?? 'main'),
  moveGfsResource: async (
    resourceId: string,
    destinationId: string,
    _expectedSessionGeneration: number,
    drive?: string,
    ifMatch?: number,
    newName?: string
  ) =>
    activeClient!.moveResource(
      { resourceId, destinationId, drive, ifMatch, newName },
      'fixture-session-token'
    ),
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

async function mountMoveRetryScenario(
  retryFailure: {
    status: number
    code: string
    message: string
  },
  raceCommit = false,
  dragMode = false
) {
  const retryGate = deferred<void>()
  const commitGate = deferred<void>()
  let markRetryStarted!: () => void
  let markMoveStarted!: () => void
  const retryStarted = new Promise<void>(resolve => {
    markRetryStarted = resolve
  })
  const moveStarted = new Promise<void>(resolve => {
    markMoveStarted = resolve
  })
  let retryPhase = false
  let staleResponseServed = false
  let moveRequests = 0
  let currentAffordanceReads = 0
  const source = accessibleResource('move-report', 'Report.txt', 'file', {
    parentResourceId: 'source-parent',
    path: '/Team/Report.txt',
    version: 4,
    permissions: ['read'],
  })
  const archive = accessibleResource('archive', 'Archive', 'directory', {
    permissions: ['read', 'write'],
  })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/v1/me/gfs/resources') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data: await listAccessiblePage([source, archive]) }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/me/gfs/resolve') {
      const resource =
        url.searchParams.get('uri') === currentUri
          ? resolvedDirectory('0123456789abcdef0123456789abcdef', 'Current Files folder')
          : resolvedFile('move-report', 'Report.txt', {
              parentResourceId: 'source-parent',
              version: 4,
            })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data: resource }))
      return
    }
    if (request.method === 'GET' && url.pathname.endsWith('/affordances')) {
      if (url.pathname.includes('/0123456789abcdef0123456789abcdef/affordances')) {
        currentAffordanceReads += 1
      }
      if (
        retryPhase &&
        !staleResponseServed &&
        url.pathname.includes('/source-parent/affordances')
      ) {
        markRetryStarted()
        await retryGate.promise
        staleResponseServed = true
        response.writeHead(retryFailure.status, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: false,
            error: { code: retryFailure.code, message: retryFailure.message },
          })
        )
        return
      }
      const isSourceParent = url.pathname.includes('/source-parent/')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          held: isSourceParent ? ['read', 'write', 'delete'] : ['read', 'write'],
          isOperator: false,
        })
      )
      return
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/move-report')) {
      moveRequests += 1
      if (raceCommit) {
        markMoveStarted()
        await commitGate.promise
        response.writeHead(retryFailure.status, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: false,
            error: { code: retryFailure.code, message: retryFailure.message },
          })
        )
        return
      }
      retryPhase = true
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      )
      return
    }
    if (request.method === 'GET' && url.pathname.endsWith('/children')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data: await listChildrenPage([]) }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  activeClient = new GfsClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestJson,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  releaseMoveRetryResponse = () => retryGate.resolve()
  releaseMoveCommitResponse = () => commitGate.resolve()

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      ...electron.clerum,
      auth: { getSessionGeneration: async () => generation },
    },
  })
  const currentResolved = await window.clerum.gfs.resolve(currentUri)
  expect(currentResolved.resourceId).toBe('0123456789abcdef0123456789abcdef')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const surface = () => (
    <QueryClientProvider client={queryClient}>
      <GfsDragSessionProvider>
        <FileExplorerTree
          onOpenFolder={vi.fn()}
          onOpenPreview={vi.fn()}
          onResourceAction={vi.fn()}
          pushToast={vi.fn()}
        />
      </GfsDragSessionProvider>
      <FilesLocationProbe />
    </QueryClientProvider>
  )
  const view = render(surface())
  await screen.findByRole('button', { name: 'Report.txt' })
  fireEvent.click(screen.getByRole('button', { name: 'Open current Files folder' }))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(currentUri)).catch(
    () => {
      throw new Error(`Files location did not open; IPC errors: ${JSON.stringify(electron.errors)}`)
    }
  )
  if (dragMode) {
    await screen.findByRole('button', { name: 'Archive' })
    return {
      queryClient,
      get moveRequests() {
        return moveRequests
      },
      get currentAffordanceReads() {
        return currentAffordanceReads
      },
      beginDrag: async () => {
        retryPhase = true
        const sourceButton = screen.getByRole('button', { name: 'Report.txt' })
        const targetButton = screen.getByRole('button', { name: 'Archive' })
        const targetRow = targetButton
          .closest('[role="treeitem"]')!
          .querySelector('.da-file-explorer__row')!
        const dataTransfer = {
          types: ['application/x-evenfire-gfs-resource'],
          files: [],
          effectAllowed: 'move',
          dropEffect: 'none',
          setData: vi.fn(),
        }
        fireEvent.dragStart(sourceButton, { dataTransfer })
        fireEvent.dragEnter(targetRow, { dataTransfer })
        fireEvent.dragOver(targetRow, { dataTransfer })
        fireEvent.drop(targetRow, { dataTransfer })
        await retryStarted
      },
      publishRenewedGeneration: () => {
        generation = 8
        auth.generation = 8
        view.rerender(surface())
      },
    }
  }
  fireEvent.keyDown(screen.getByRole('button', { name: 'Report.txt' }), {
    key: 'F10',
    shiftKey: true,
  })
  const dialog = await screen.findByRole('dialog', { name: 'Move file Report.txt' })
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
  if (raceCommit) {
    await moveStarted
  } else {
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Retry permission check' }))
    await retryStarted
  }

  return {
    queryClient,
    get currentAffordanceReads() {
      return currentAffordanceReads
    },
    releaseCommitResponse: () => commitGate.resolve(),
    publishRenewedGeneration: () => {
      generation = 8
      auth.generation = 8
      view.rerender(surface())
    },
  }
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
  electron.errors.splice(0)
  activeClient = null
  releaseResponse = null
  releaseMoveRetryResponse?.()
  releaseMoveRetryResponse = null
  releaseMoveCommitResponse?.()
  releaseMoveCommitResponse = null
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  )
})

function FilesLocationProbe() {
  const controller = useGfsBrowserController()
  return (
    <>
      <button onClick={() => void controller.openUri(currentUri)}>Open current Files folder</button>
      <button onClick={() => void controller.refreshAffordances?.()}>
        Refresh current Files permissions
      </button>
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
  it('preserves sibling Files after a stale drag affordance 401', async () => {
    const mounted = await mountMoveRetryScenario(
      { status: 401, code: 'unauthenticated', message: 'unauthenticated' },
      false,
      true
    )
    await mounted.beginDrag?.()
    generation = 8
    releaseMoveRetryResponse?.()
    await waitFor(() =>
      expect(
        electron.errors.some(
          message =>
            message.includes('gfs:affordances') &&
            message.includes('__CLERUM_GFS_STALE_AUTHORITY_V1__:stale:')
        )
      ).toBe(true)
    )
    expect(screen.getByTestId('access').textContent).toBe('active')
    expect(screen.getByTestId('location').textContent).toBe(currentUri)
    expect(mounted.moveRequests).toBe(0)
    await mounted.publishRenewedGeneration()
    expect(screen.getByTestId('access').textContent).toBe('active')
    expect(screen.getByTestId('location').textContent).toBe(currentUri)
  })

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
    {
      label: 'stale 401 after renewal',
      failure: { status: 401, code: 'unauthenticated', message: 'unauthenticated' },
      renew: true,
      expectedAccess: 'active',
      expectedLocation: currentUri,
    },
    {
      label: 'current-session 401',
      failure: { status: 401, code: 'unauthenticated', message: 'unauthenticated' },
      renew: false,
      expectedAccess: 'revoked',
      expectedLocation: 'no-location',
    },
    {
      label: 'current lifecycle 403',
      failure: { status: 403, code: 'desktop_user_retired', message: 'desktop_user_retired' },
      renew: false,
      expectedAccess: 'revoked',
      expectedLocation: 'no-location',
    },
    {
      label: 'resource-local 403',
      failure: { status: 403, code: 'forbidden', message: 'forbidden' },
      renew: false,
      expectedAccess: 'active',
      expectedLocation: currentUri,
    },
    {
      label: 'missing resource 404',
      failure: { status: 404, code: 'not_found', message: 'not found' },
      renew: false,
      expectedAccess: 'active',
      expectedLocation: currentUri,
    },
  ])(
    'preserves Move retry authority semantics for $label',
    async ({ failure, renew, expectedAccess, expectedLocation }) => {
      const mounted = await mountMoveRetryScenario(failure)

      if (renew) generation = 8
      releaseMoveRetryResponse?.()
      await waitFor(() =>
        expect(
          electron.errors.some(
            message =>
              message.includes('gfs:affordances') &&
              (renew
                ? message.includes('__CLERUM_GFS_STALE_AUTHORITY_V1__:stale:')
                : message.includes(failure.code))
          )
        ).toBe(true)
      )
      await waitFor(() => expect(screen.getByTestId('access').textContent).toBe(expectedAccess))
      await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(expectedLocation))

      if (renew) {
        expect(screen.getByRole('dialog', { name: 'Move file Report.txt' })).toBeTruthy()
        await mounted.publishRenewedGeneration()
        await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('active'))
        await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(currentUri))
        const affordancesBeforeRetry = mounted.currentAffordanceReads
        fireEvent.click(screen.getByRole('button', { name: 'Refresh current Files permissions' }))
        await waitFor(() =>
          expect(mounted.currentAffordanceReads).toBeGreaterThan(affordancesBeforeRetry)
        )
        expect(screen.getByTestId('access').textContent).toBe('active')
        expect(screen.getByTestId('location').textContent).toBe(currentUri)
      }
    }
  )

  it('keeps a stale Move commit 401 from revoking sibling Files state', async () => {
    const mounted = await mountMoveRetryScenario(
      { status: 401, code: 'unauthenticated', message: 'unauthenticated' },
      true
    )
    generation = 8
    mounted.releaseCommitResponse?.()
    await waitFor(() =>
      expect(
        electron.errors.some(
          message =>
            message.includes('gfs:moveResource') &&
            message.includes('__CLERUM_GFS_STALE_AUTHORITY_V1__:stale:')
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move file Report.txt' })).toBeNull()
    )
    expect(screen.getByTestId('access').textContent).toBe('active')
    expect(screen.getByTestId('location').textContent).toBe(currentUri)

    await mounted.publishRenewedGeneration()
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('active'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(currentUri))
    const affordancesBeforeRetry = mounted.currentAffordanceReads
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current Files permissions' }))
    await waitFor(() =>
      expect(mounted.currentAffordanceReads).toBeGreaterThan(affordancesBeforeRetry)
    )
    expect(screen.getByTestId('access').textContent).toBe('active')
    expect(screen.getByTestId('location').textContent).toBe(currentUri)
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
