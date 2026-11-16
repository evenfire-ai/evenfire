// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { type Query, QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import type { PermissionErrorItem } from '@components/Common/PermissionErrorDialog/types'
import {
  isPermissionErrorAcknowledged,
  permissionErrorToken,
} from '@components/Common/permissionErrorAcknowledgement'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesFailureMessage,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'
import { FilesPage } from '../FilesPage'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

const FOLDER_URI = 'gfs://main/aaa'
const me = {
  id: 'user-1',
  email: 'user@example.test',
  name: 'User One',
  picture: null,
  teamId: 'team-1',
  teamName: 'Team One',
  role: 'member' as const,
}

const authValue = {
  isAuthenticated: true,
  sessionGeneration: 0,
  me,
  runtimeConfigState: { envKey: 'test-environment' },
} as unknown as AuthContextValue

function wrapper(client: QueryClient) {
  const clerum = (window as unknown as { clerum?: Record<string, unknown> }).clerum
  if (clerum) {
    const auth = (clerum.auth ?? {}) as Record<string, unknown>
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        ...clerum,
        auth: {
          ...auth,
          getSessionGeneration:
            typeof auth.getSessionGeneration === 'function'
              ? auth.getSessionGeneration
              : vi.fn(async () => 0),
        },
      },
    })
  }
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
  }
}

describe('FilesPage stale permission action oracle', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    focusManager.setFocused(undefined)
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('runs generated recovery and stale-binding commands through the production FilesPage', async () => {
    type Model = {
      failed: boolean
      acknowledged: boolean
      folder: 'A' | 'B'
    }
    type Real = {
      client: QueryClient
      sourceKey: ReturnType<typeof desktopQueryKeys.gfsAffordances>
      sourceQuery: Query
      getReads: () => number
      setOutcome: (outcome: 'success' | 'failure') => void
      refetchSource: () => Promise<void>
      remount: () => Promise<void>
      navigate: (folder: 'A' | 'B') => Promise<void>
    }

    class PublishFailure implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return !model.failed && model.folder === 'A'
      }
      async run(model: Model, state: Real): Promise<void> {
        state.setOutcome('failure')
        await state.refetchSource()
        model.failed = true
        model.acknowledged = false
        expect(await screen.findByRole('alertdialog')).toBeTruthy()
        expect(state.client.getQueryState(state.sourceKey)?.status).toBe('error')
      }
      toString(): string {
        return 'publish a producer-backed source-parent permission failure'
      }
    }

    class DismissFailure implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.failed && !model.acknowledged && model.folder === 'A'
      }
      async run(model: Model): Promise<void> {
        const dialog = await screen.findByRole('alertdialog')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
        model.acknowledged = true
      }
      toString(): string {
        return 'dismiss the visible production Files permission dialog'
      }
    }

    class RepeatBackgroundFailure implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.failed && model.acknowledged && model.folder === 'A'
      }
      async run(_model: Model, state: Real): Promise<void> {
        const before = state.client.getQueryState(state.sourceKey)?.errorUpdateCount ?? 0
        const focusTarget = screen.getByRole('button', { name: 'Options for Reports' })
        focusTarget.focus()
        state.setOutcome('failure')
        await state.refetchSource()
        expect(state.client.getQueryState(state.sourceKey)?.errorUpdateCount).toBeGreaterThan(
          before
        )
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(document.activeElement).toBe(focusTarget)
      }
      toString(): string {
        return 'repeat a background failure without reopening the dismissed dialog'
      }
    }

    class Recover implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.failed && model.acknowledged && model.folder === 'A'
      }
      async run(model: Model, state: Real): Promise<void> {
        state.setOutcome('success')
        await state.refetchSource()
        model.failed = false
        model.acknowledged = false
        expect(state.client.getQueryState(state.sourceKey)?.status).toBe('success')
        expect(screen.queryByRole('alertdialog')).toBeNull()
      }
      toString(): string {
        return 'recover the exact permission Query through its real producer'
      }
    }

    class NewFailure implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return !model.failed && model.folder === 'A'
      }
      async run(model: Model, state: Real): Promise<void> {
        state.setOutcome('failure')
        await state.refetchSource()
        model.failed = true
        model.acknowledged = false
        expect(await screen.findByRole('alertdialog')).toBeTruthy()
      }
      toString(): string {
        return 'publish a new failure after successful recovery'
      }
    }

    class RetryFailure implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.failed && !model.acknowledged && model.folder === 'A'
      }
      async run(_model: Model, state: Real): Promise<void> {
        const before = state.getReads()
        state.setOutcome('failure')
        fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
        await waitFor(() => expect(state.getReads()).toBeGreaterThan(before))
        await waitFor(() =>
          expect(state.client.getQueryState(state.sourceKey)?.fetchStatus).toBe('idle')
        )
        expect(await screen.findByRole('alertdialog')).toBeTruthy()
      }
      toString(): string {
        return 'admit an explicit production Retry and expose its failure'
      }
    }

    class Remount implements AsyncCommand<Model, Real, true> {
      async check(): Promise<boolean> {
        return true
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.remount()
        expect(state.client.getQueryCache().find({ exact: true, queryKey: state.sourceKey })).toBe(
          state.sourceQuery
        )
        expect(Boolean(screen.queryByRole('alertdialog'))).toBe(
          model.failed && !model.acknowledged && model.folder === 'A'
        )
      }
      toString(): string {
        return 'remount the production page while preserving the exact Query episode'
      }
    }

    class NavigateAway implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.folder === 'A' && model.failed && !model.acknowledged
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.navigate('B')
        model.folder = 'B'
        expect(screen.queryByRole('alertdialog')).toBeNull()
      }
      toString(): string {
        return 'navigate to B and verify the committed UI no longer presents A recovery'
      }
    }

    class ReturnToOrigin implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.folder === 'B'
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.navigate('A')
        model.folder = 'A'
        expect(Boolean(screen.queryByRole('alertdialog'))).toBe(model.failed && !model.acknowledged)
      }
      toString(): string {
        return 'return to the exact A binding and restore only its current episode'
      }
    }

    const folderAUri = FOLDER_URI
    const folderBUri = 'gfs://main/bbb'
    const folderA = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: folderAUri,
        parentResourceId: 'source-parent',
      })
    )
    const folderB = await resolveResource(
      resolvedDirectory('folder-next', 'Archive', {
        gfsUri: folderBUri,
        parentResourceId: 'other-parent',
      })
    )
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    let outcome: 'success' | 'failure' = 'success'
    let reads = 0
    const producer = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === 'source-parent') {
        reads += 1
        if (outcome === 'failure') throw new Error(denied)
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === folderBUri ? folderB : folderA)),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn((resourceId: string) => producer(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const sourceKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'source-parent',
      'main',
      0
    )
    let view: { unmount: () => void; rerender: (node: ReactNode) => void } | undefined
    let currentFolder: 'A' | 'B' = 'A'
    try {
      const renderPage = () => (
        <FilesPage pendingGfsUri={currentFolder === 'A' ? folderAUri : folderBUri} />
      )
      const commands = fc.commands<Model, Real, true>(
        [
          fc.constant(new PublishFailure()),
          fc.constant(new DismissFailure()),
          fc.constant(new RepeatBackgroundFailure()),
          fc.constant(new Recover()),
          fc.constant(new NewFailure()),
          fc.constant(new RetryFailure()),
          fc.constant(new Remount()),
          fc.constant(new NavigateAway()),
          fc.constant(new ReturnToOrigin()),
        ],
        { maxCommands: 10 }
      )
      await fc.assert(
        fc.asyncProperty(commands, async scheduled => {
          view?.unmount()
          client.clear()
          reads = 0
          outcome = 'success'
          currentFolder = 'A'
          view = render(renderPage(), { wrapper: wrapper(client) })
          await screen.findByRole('button', { name: 'Options for Reports' })
          await waitFor(() => expect(reads).toBe(1))
          const sourceQuery = client.getQueryCache().find({ exact: true, queryKey: sourceKey })
          if (!sourceQuery) throw new Error('Expected the real Files permission Query')
          const state: Real = {
            client,
            sourceKey,
            sourceQuery,
            getReads: () => reads,
            setOutcome: value => {
              outcome = value
            },
            refetchSource: async () => {
              await act(async () => {
                await client.refetchQueries({ exact: true, queryKey: sourceKey })
              })
            },
            remount: async () => {
              view?.unmount()
              await act(async () => Promise.resolve())
              view = render(renderPage(), { wrapper: wrapper(client) })
              await screen.findByRole('button', {
                name: currentFolder === 'A' ? 'Options for Reports' : 'Options for Archive',
              })
            },
            navigate: async folder => {
              currentFolder = folder
              view?.rerender(renderPage())
              await screen.findByRole('button', {
                name: folder === 'A' ? 'Options for Reports' : 'Options for Archive',
              })
            },
          }
          const model: Model = { failed: false, acknowledged: false, folder: 'A' }
          await fc.asyncModelRun(() => ({ model, real: state }), scheduled)
          expect(state.client.getQueryCache().find({ exact: true, queryKey: sourceKey })).toBe(
            state.sourceQuery
          )
        }),
        { numRuns: 24, seed: 142715 }
      )
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it('shares one acknowledged Query episode between production Files and Preview callers', async () => {
    const sharedUri = 'gfs://main/source-parent'
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const previewResource = resolveResource({
      resourceId: 'source-parent',
      rid: 'source-parent',
      gfsUri: sharedUri,
      drive: 'main',
      parentResourceId: 'folder-active',
      name: 'shared.png',
      kind: 'file',
      version: 1,
      bytes: 1,
    })
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    let outcome: 'success' | 'failure' = 'success'
    let reads = 0
    const producer = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === 'source-parent') {
        reads += 1
        if (outcome === 'failure') throw new Error(denied)
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 0) },
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === sharedUri ? previewResource : folder)),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn((resourceId: string) => producer(resourceId)),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const sharedKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'source-parent',
      'main',
      0
    )

    try {
      render(
        <>
          <FilesPage pendingGfsUri={FOLDER_URI} />
          <FilePreviewPage
            gfsUri={sharedUri}
            fileName="shared.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
        </>,
        { wrapper: wrapper(client) }
      )
      await screen.findByRole('button', { name: 'Options for Reports' })
      await screen.findByAltText('Preview of shared.png')
      await waitFor(() => expect(reads).toBe(1))
      const sharedQuery = client.getQueryCache().find({ exact: true, queryKey: sharedKey })
      expect(sharedQuery?.state.status).toBe('success')

      outcome = 'failure'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: sharedKey })
      })
      expect(reads).toBe(2)
      expect(sharedQuery?.state.status).toBe('error')
      expect(screen.getAllByRole('alertdialog')).toHaveLength(2)

      const firstDialog = screen.getAllByRole('alertdialog')[0]
      if (!firstDialog) throw new Error('Expected one shared-Query permission dialog')
      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryAllByRole('alertdialog')).toHaveLength(0))
      expect(client.getQueryCache().find({ exact: true, queryKey: sharedKey })).toBe(sharedQuery)

      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: sharedKey })
      })
      expect(reads).toBe(3)
      expect(sharedQuery?.state.errorUpdateCount).toBe(2)
      expect(screen.queryAllByRole('alertdialog')).toHaveLength(0)
    } finally {
      client.clear()
    }
  })

  it('keeps a deferred Files Retry failure out of the Preview binding for the same Query', async () => {
    const sharedUri = 'gfs://main/source-parent'
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const previewResource = await resolveResource({
      resourceId: 'source-parent',
      rid: 'source-parent',
      gfsUri: sharedUri,
      drive: 'main',
      parentResourceId: 'folder-active',
      name: 'shared.png',
      kind: 'file',
      version: 1,
      bytes: 1,
    })
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    let reads = 0
    let rejectRetry!: (reason: Error) => void
    const heldRetry = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (_resolve, reject) => {
        rejectRetry = reject
      }
    )
    const producer = appServiceAffordanceProducer(async resourceId => {
      if (resourceId !== 'source-parent') return heldPermissionResponse(['read', 'write', 'delete'])
      reads += 1
      if (reads === 2) throw new Error(denied)
      if (reads === 3) return heldRetry
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 0) },
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === sharedUri ? previewResource : folder)),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn((resourceId: string) => producer(resourceId)),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const sharedKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'source-parent',
      'main',
      0
    )

    try {
      render(
        <>
          <FilesPage pendingGfsUri={FOLDER_URI} />
          <FilePreviewPage
            gfsUri={sharedUri}
            fileName="shared.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
        </>,
        { wrapper: wrapper(client) }
      )
      await screen.findByRole('button', { name: 'Options for Reports' })
      await screen.findByAltText('Preview of shared.png')
      await waitFor(() => expect(reads).toBe(1))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: sharedKey })
      })
      await waitFor(() => expect(reads).toBe(2))
      await waitFor(() => expect(screen.getAllByRole('alertdialog')).toHaveLength(2))

      const filesDialog = screen
        .getAllByRole('alertdialog')
        .find(dialog => dialog.textContent?.includes('Could not verify Move permissions'))
      expect(filesDialog).toBeTruthy()
      fireEvent.click(within(filesDialog!).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(reads).toBe(3))
      await waitFor(() => expect(client.getQueryState(sharedKey)?.fetchStatus).toBe('fetching'))
      const recoveryCues = screen.getAllByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      fireEvent.click(recoveryCues.at(-1)!)
      const previewDialog = screen.getAllByRole('alertdialog').at(-1)!
      fireEvent.click(within(previewDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(client.getQueryState(sharedKey)?.fetchStatus).toBe('fetching'))
      expect(reads).toBe(3)

      await act(async () => {
        rejectRetry(new Error(denied))
      })
      await waitFor(() => expect(client.getQueryState(sharedKey)?.errorUpdateCount).toBe(2))
      const remainingDialogs = screen.getAllByRole('alertdialog')
      expect(remainingDialogs).toHaveLength(1)
      expect(remainingDialogs[0]?.textContent).toContain('Could not verify Move permissions')
      expect(remainingDialogs[0]?.textContent).not.toContain('Could not verify file permissions')
    } finally {
      if (reads >= 3 && client.getQueryState(sharedKey)?.fetchStatus === 'fetching') {
        rejectRetry(new Error(denied))
      }
      client.clear()
    }
  })

  it('routes a pending A Retry 401 after Files commits B through retained session authority', async () => {
    const folderBUri = 'gfs://main/bbb'
    const folderA = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const folderB = await resolveResource(
      resolvedDirectory('folder-next', 'Archive', {
        gfsUri: folderBUri,
        parentResourceId: 'other-parent',
      })
    )
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const authorityFailure = await affordancesFailureMessage(
      401,
      { code: 'unauthorized', message: 'session expired' },
      'source-parent'
    )
    let reads = 0
    let rejectRetry!: (reason: Error) => void
    const heldRetry = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (_resolve, reject) => {
        rejectRetry = reject
      }
    )
    const producer = appServiceAffordanceProducer(async resourceId => {
      if (resourceId !== 'source-parent') return heldPermissionResponse(['read', 'write', 'delete'])
      reads += 1
      if (reads === 2) throw new Error(denied)
      if (reads === 3) return heldRetry
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 0) },
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === folderBUri ? folderB : folderA)),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn((resourceId: string) => producer(resourceId)),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const scope = 'test-environment:user-1:team-1'
    const generation = 0
    const sharedKey = desktopQueryKeys.gfsAffordances(scope, 'source-parent', 'main', generation)
    const accessKey = desktopQueryKeys.gfsAccessState(scope, generation)
    let currentFolder: 'A' | 'B' = 'A'
    const renderFiles = () => (
      <FilesPage pendingGfsUri={currentFolder === 'A' ? FOLDER_URI : folderBUri} />
    )

    try {
      const view = render(renderFiles(), { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(reads).toBe(1))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: sharedKey })
      })
      await waitFor(() => expect(reads).toBe(2))
      const filesDialog = await screen.findByRole('alertdialog')
      expect(filesDialog.textContent).toContain('Could not verify Move permissions')
      fireEvent.click(within(filesDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(reads).toBe(3))
      await waitFor(() => expect(client.getQueryState(sharedKey)?.fetchStatus).toBe('fetching'))

      currentFolder = 'B'
      view.rerender(renderFiles())
      await screen.findByRole('button', { name: 'Options for Archive' })
      const sourceQuery = client.getQueryCache().find({ exact: true, queryKey: sharedKey })
      expect(sourceQuery).toBeTruthy()
      await waitFor(() => expect(sourceQuery?.getObserversCount()).toBe(0))
      expect(client.getQueryData(accessKey)).toBe('active')

      await act(async () => {
        rejectRetry(new Error(authorityFailure))
      })
      expect(await screen.findByText('File access is not authorized')).toBeTruthy()
      await waitFor(() => expect(client.getQueryData(accessKey)).toBe('revoked'))
      expect(client.getQueryCache().find({ exact: true, queryKey: sharedKey })).toBeUndefined()
      expect(screen.queryAllByRole('alertdialog')).toHaveLength(0)
      expect(screen.queryByText(/Could not verify Move permissions/)).toBeNull()
    } finally {
      if (reads >= 3 && client.getQueryState(sharedKey)?.fetchStatus === 'fetching') {
        rejectRetry(new Error(authorityFailure))
      }
      client.clear()
    }
  })

  it('orders the same producer terminal against the production B1 to B2 React commit', async () => {
    const folderBUri = 'gfs://main/bbb'
    const folderA = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const folderB = await resolveResource(
      resolvedDirectory('folder-next', 'Archive', {
        gfsUri: folderBUri,
        parentResourceId: 'other-parent',
      })
    )
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const observedOrders = new Set<string>()

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        let scheduledFailure = false
        const affordanceProducer = appServiceAffordanceProducer(async resourceId => {
          if (resourceId === 'source-parent' && scheduledFailure) {
            return scheduler
              .schedule(Promise.resolve(heldPermissionResponse(['read'])), 'A permission producer')
              .then(() => {
                throw new Error(denied)
              })
          }
          return heldPermissionResponse(['read', 'write', 'delete'])
        })
        Object.defineProperty(window, 'clerum', {
          configurable: true,
          value: {
            gfs: {
              listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
              resolve: vi.fn(async (uri: string) => (uri === folderBUri ? folderB : folderA)),
              listChildren: vi.fn(async () => listChildrenPage([])),
              affordances: vi.fn((resourceId: string) => affordanceProducer(resourceId)),
            },
          },
        })
        const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
        const sourceKey = desktopQueryKeys.gfsAffordances(
          'test-environment:user-1:team-1',
          'source-parent',
          'main',
          0
        )
        let sourceQueryHash: string | undefined
        let currentFolder: 'A' | 'B' = 'A'
        const renderPage = () => (
          <FilesPage pendingGfsUri={currentFolder === 'A' ? FOLDER_URI : folderBUri} />
        )
        const view = render(renderPage(), { wrapper: wrapper(client) })
        const order: string[] = []
        const unsubscribe = client.getQueryCache().subscribe(event => {
          if (
            event.type === 'updated' &&
            event.query.queryHash === sourceQueryHash &&
            event.action.type === 'error'
          ) {
            order.push('A-terminal')
          }
        })
        try {
          await screen.findByRole('button', { name: 'Options for Reports' })
          const sourceQuery = client.getQueryCache().find({ exact: true, queryKey: sourceKey })
          if (!sourceQuery) throw new Error('Expected the production Files source Query')
          sourceQueryHash = sourceQuery.queryHash
          scheduledFailure = true
          const terminal = client.refetchQueries({ exact: true, queryKey: sourceKey })
          await waitFor(() => expect(scheduler.count()).toBe(1))
          const commitB = scheduler.schedule(Promise.resolve(), 'B React commit').then(() => {
            act(() => {
              currentFolder = 'B'
              view.rerender(renderPage())
            })
            order.push('B-commit')
          })
          await waitFor(() => expect(scheduler.count()).toBe(2))
          await scheduler.waitIdle()
          await Promise.all([terminal, commitB])
          await screen.findByRole('button', { name: 'Options for Archive' })
          expect(order).toHaveLength(2)
          expect(order).toContain('A-terminal')
          expect(order).toContain('B-commit')
          observedOrders.add(order.join(','))
          expect(client.getQueryCache().find({ exact: true, queryKey: sourceKey })).toBe(
            sourceQuery
          )
          expect(sourceQuery.state.status).toBe('error')
          expect(screen.getByRole('button', { name: 'Options for Archive' })).toBeTruthy()
          expect(screen.queryByRole('alertdialog')).toBeNull()
        } finally {
          unsubscribe()
          view.unmount()
          client.clear()
        }
      }),
      { numRuns: 60, seed: 142716 }
    )

    expect(observedOrders).toEqual(new Set(['A-terminal,B-commit', 'B-commit,A-terminal']))
  })

  it('preserves the shared source-parent Query error after folder navigation commits', async () => {
    const nextFolderUri = 'gfs://main/bbb'
    const firstFolder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const secondFolder = await resolveResource(
      resolvedDirectory('folder-next', 'Archive', {
        gfsUri: nextFolderUri,
        parentResourceId: 'source-parent',
      })
    )
    const sourceFailure = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const sourceParentReads = vi.fn(async () => {
      throw new Error(sourceFailure)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? firstFolder : secondFolder)),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent'
              ? sourceParentReads()
              : heldPermissionResponse(['read', 'write', 'delete'])
          ),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const view = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    try {
      await screen.findByText(/Could not verify Move permissions:/)
      const sourceKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'source-parent',
        'main',
        0
      )
      const originalQuery = client.getQueryCache().find({ exact: true, queryKey: sourceKey })
      expect(originalQuery?.state.status).toBe('error')

      view.rerender(<FilesPage pendingGfsUri={nextFolderUri} />)
      await screen.findByRole('button', { name: 'Options for Archive' })
      expect(client.getQueryCache().find({ exact: true, queryKey: sourceKey })).toBe(originalQuery)
      expect(client.getQueryState(sourceKey)?.errorUpdateCount).toBe(1)
      const dialog = screen.getByRole('alertdialog')
      expect(within(dialog).getByText(/Could not verify Move permissions:/)).toBeTruthy()
      expect(sourceParentReads).toHaveBeenCalledTimes(1)
    } finally {
      client.clear()
    }
  })

  it('does not reactivate an old Files binding during a new-session pending seed', async () => {
    const nextFolderUri = 'gfs://main/new-session-folder'
    const oldFolder = await resolveResource(
      resolvedDirectory('folder-old-session', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const nextFolder = await resolveResource(
      resolvedDirectory('folder-new-session', 'Projects', { gfsUri: nextFolderUri })
    )
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Shared', {
        gfsUri: 'gfs://main/source-parent',
      })
    )
    const sourceFailure = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    let activeGeneration = 0
    let releaseSeed!: (resource: typeof nextFolder) => void
    const pendingSeed = new Promise<typeof nextFolder>(resolve => {
      releaseSeed = resolve
    })
    const resolve = vi.fn((uri: string) =>
      uri === FOLDER_URI
        ? Promise.resolve(oldFolder)
        : uri === nextFolderUri
          ? pendingSeed
          : Promise.resolve(sourceParent)
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'source-parent' && activeGeneration === 0) {
        throw new Error(sourceFailure)
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => activeGeneration) },
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstSession = authValue
    const nextSession = {
      ...authValue,
      me: { ...me, id: 'user-2' },
      sessionGeneration: 1,
    } as unknown as AuthContextValue
    const renderSession = (auth: AuthContextValue, pendingGfsUri: string) => (
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={client}>
          <FilesPage pendingGfsUri={pendingGfsUri} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    try {
      const oldPage = render(renderSession(firstSession, FOLDER_URI))
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(FOLDER_URI))
      await screen.findByText(/Could not verify Move permissions:/)

      activeGeneration = 1
      oldPage.rerender(renderSession(nextSession, nextFolderUri))
      await waitFor(() => expect(window.clerum.gfs.resolve).toHaveBeenCalledWith(nextFolderUri))
      await waitFor(() =>
        expect(screen.queryByText(/Could not verify Move permissions:/)).toBeNull()
      )
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
      ).toBeNull()
      oldPage.unmount()
    } finally {
      releaseSeed(nextFolder)
      await act(async () => pendingSeed)
      client.clear()
    }
  })

  it.each(['success', 'failure'] as const)(
    'does not reactivate a dormant old-team Files binding after a %s seed on remount',
    async seedOutcome => {
      const nextFolderUri = 'gfs://main/new-team-folder'
      const oldFolder = await resolveResource(
        resolvedDirectory('folder-old-team', 'Reports', {
          gfsUri: FOLDER_URI,
          parentResourceId: 'source-parent',
        })
      )
      const nextFolder = await resolveResource(
        resolvedDirectory('folder-new-team', 'Projects', { gfsUri: nextFolderUri })
      )
      const sourceParent = await resolveResource(
        resolvedDirectory('source-parent', 'Shared', { gfsUri: 'gfs://main/source-parent' })
      )
      const sourceFailure = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'source-parent'
      )
      let activeGeneration = 0
      let resolveSeed!: (folder: typeof nextFolder) => void
      let rejectSeed!: (reason: Error) => void
      const pendingSeed = new Promise<typeof nextFolder>((resolve, reject) => {
        resolveSeed = resolve
        rejectSeed = reject
      })
      const resolve = vi.fn((uri: string) =>
        uri === FOLDER_URI
          ? Promise.resolve(oldFolder)
          : uri === nextFolderUri
            ? pendingSeed
            : Promise.resolve(sourceParent)
      )
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'source-parent' && activeGeneration === 0) {
          throw new Error(sourceFailure)
        }
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          auth: { getSessionGeneration: vi.fn(async () => activeGeneration) },
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve,
            listChildren: vi.fn(async () => listChildrenPage([])),
            affordances,
          },
        },
      })
      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const oldScope = 'test-environment:user-1:team-1'
      const staleQueryKey = desktopQueryKeys.gfsAffordances(oldScope, 'source-parent', 'main', 0)
      const renderSession = (session: AuthContextValue, pendingGfsUri: string) => (
        <AuthContext.Provider value={session}>
          <QueryClientProvider client={client}>
            <FilesPage pendingGfsUri={pendingGfsUri} />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
      try {
        const oldPage = render(renderSession(authValue, FOLDER_URI))
        await screen.findByText(/Could not verify Move permissions:/)
        expect(screen.getByRole('alertdialog')).toBeTruthy()
        expect(
          client.getQueryCache().find({ queryKey: staleQueryKey, exact: true })?.state.status
        ).toBe('error')
        oldPage.unmount()
        activeGeneration = 1
        const nextSession = {
          ...authValue,
          me: { ...me, teamId: 'team-2', teamName: 'Team Two' },
          sessionGeneration: 1,
        } as unknown as AuthContextValue
        render(renderSession(nextSession, nextFolderUri))
        await waitFor(() => expect(resolve).toHaveBeenCalledWith(nextFolderUri))
        expect(client.getQueryCache().find({ queryKey: staleQueryKey, exact: true })).toBeTruthy()
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(
          screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
        ).toBeNull()

        await act(async () => {
          if (seedOutcome === 'success') resolveSeed(nextFolder)
          else rejectSeed(new Error('new-team location seed failed'))
          await pendingSeed.catch(() => undefined)
        })
        if (seedOutcome === 'success') {
          await screen.findByRole('button', { name: 'Options for Projects' })
        }
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
        expect(
          screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
        ).toBeNull()
      } finally {
        if (seedOutcome === 'success') resolveSeed(nextFolder)
        else rejectSeed(new Error('test cleanup'))
        await pendingSeed.catch(() => undefined)
        client.clear()
      }
    }
  )

  it('routes a settled child-row 401 to session revocation without a local permission dialog', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const authorityError = await affordancesFailureMessage(
      401,
      { code: 'unauthorized', message: 'The session is not authorized.' },
      'child-report'
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') throw new Error(authorityError)
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByText('File access is not authorized')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Retry file access' })).toBeTruthy()
      expect(affordances).toHaveBeenCalledWith('child-report', 'main')
    } finally {
      client.clear()
    }
  })

  it.each(['success', 'failure'] as const)(
    'keeps a retained row error ineligible until authority revalidation reenables its query (%s)',
    async outcome => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const report = childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      })
      const children = await listChildrenPage([report])
      let releaseDiscovery!: (value: Awaited<ReturnType<typeof listAccessiblePage>>) => void
      let rejectRow!: (reason: Error) => void
      const discovery = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
        releaseDiscovery = resolve
      })
      let releaseRow!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
      const rowRefresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
        (resolve, reject) => {
          releaseRow = resolve
          rejectRow = reject
        }
      )
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'child-report') return rowRefresh
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(() => discovery),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const rowKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'child-report',
        'main',
        0
      )
      try {
        await expect(
          client.fetchQuery({
            queryKey: rowKey,
            queryFn: async () => {
              throw new Error('403 Forbidden: resource_access_denied httpStatus=403')
            },
            retry: false,
            staleTime: 0,
          })
        ).rejects.toThrow('resource_access_denied')
        const retainedQuery = client.getQueryCache().find({ queryKey: rowKey, exact: true })
        expect(retainedQuery?.state.status).toBe('error')
        const rowQueryIdentity = retainedQuery

        const { container } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
          wrapper: wrapper(client),
        })
        await screen.findByRole('status', { name: 'Loading files' })
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(
          rowQueryIdentity
        )
        expect(affordances).not.toHaveBeenCalledWith('child-report', 'main')

        await act(async () => {
          releaseDiscovery(await listAccessiblePage([]))
          await discovery
        })
        await screen.findByText('report.txt')
        await waitFor(() => expect(affordances).toHaveBeenCalledWith('child-report', 'main'))
        expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(
          rowQueryIdentity
        )
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')
        expect(
          screen.queryByRole('status', { name: /Checking permissions for report.txt/ })
        ).toBeNull()
        expect(container.querySelector('.da-gfs-list__name .da-permission-status-slot')).toBeNull()

        if (outcome === 'success') {
          await act(async () => {
            releaseRow(heldPermissionResponse(['read', 'write', 'delete']))
            await rowRefresh
          })
          await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('success'))
          expect(screen.queryByRole('alertdialog')).toBeNull()
        } else {
          await act(async () => {
            rejectRow(new Error('403 Forbidden: resource_access_denied httpStatus=403'))
            await rowRefresh.catch(() => undefined)
          })
          await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
          expect(await screen.findByRole('alertdialog')).toBeTruthy()
          expect(client.getQueryState(rowKey)?.errorUpdateCount).toBeGreaterThan(1)
        }
        expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(1)
      } finally {
        releaseDiscovery(await listAccessiblePage([]))
        releaseRow(heldPermissionResponse(['read', 'write', 'delete']))
        client.clear()
      }
    }
  )

  it('keeps cached permission data plus its error ineligible while the row observer is disabled', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let releaseDiscovery!: (value: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const discovery = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      releaseDiscovery = resolve
    })
    let releaseRow!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    let rejectRow!: (error: Error) => void
    const rowRefresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (resolve, reject) => {
        releaseRow = resolve
        rejectRow = reject
      }
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') return rowRefresh
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(() => discovery),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    try {
      await client.fetchQuery({
        queryKey: rowKey,
        queryFn: async () => heldPermissionResponse(['read', 'write', 'delete']),
        retry: false,
        staleTime: 0,
      })
      await expect(
        client.fetchQuery({
          queryKey: rowKey,
          queryFn: async () => {
            throw new Error('403 Forbidden: resource_access_denied httpStatus=403')
          },
          retry: false,
          staleTime: 0,
        })
      ).rejects.toThrow('resource_access_denied')
      const retained = client.getQueryCache().find({ exact: true, queryKey: rowKey })
      expect(client.getQueryState(rowKey)?.status).toBe('error')
      expect(client.getQueryState(rowKey)?.data).toBeTruthy()

      const { container } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('status', { name: 'Loading files' })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(retained)
      expect(affordances).not.toHaveBeenCalledWith('child-report', 'main')

      await act(async () => {
        releaseDiscovery(await listAccessiblePage([]))
        await discovery
      })
      await screen.findByText('report.txt')
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('child-report', 'main'))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')
      expect(
        screen.queryByRole('status', { name: /Checking permissions for report.txt/ })
      ).toBeNull()
      expect(container.querySelector('.da-gfs-list__name .da-permission-status-slot')).toBeNull()
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(retained)
      expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')

      await act(async () => {
        rejectRow(new Error('403 Forbidden: resource_access_denied httpStatus=403'))
        await rowRefresh.catch(() => undefined)
      })
      await screen.findByRole('alertdialog')
      expect(client.getQueryState(rowKey)?.status).toBe('error')
      expect(client.getQueryState(rowKey)?.data).toBeTruthy()
      expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(1)
    } finally {
      releaseDiscovery(await listAccessiblePage([]))
      releaseRow(heldPermissionResponse(['read', 'write', 'delete']))
      rejectRow(new Error('cleanup'))
      client.clear()
    }
  })

  it('reports a second row refetch inside the open permission dialog', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const reportA = childView('child-a', 'a.txt', 'file', { parentResourceId: 'folder-active' })
    const reportB = childView('child-b', 'b.txt', 'file', { parentResourceId: 'folder-active' })
    const children = await listChildrenPage([reportA, reportB])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-a'
    )
    const deniedB = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-b'
    )
    let reportBReads = 0
    let releaseRefresh!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    const refresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(resolve => {
      releaseRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'child-a') return Promise.reject(new Error(denied))
      if (resourceId === 'child-b') {
        reportBReads += 1
        return reportBReads === 1 ? Promise.reject(new Error(deniedB)) : refresh
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const errorKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-a',
      'main',
      0
    )
    const refetchKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-b',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for b.txt' })
      const dialog = await screen.findByRole('alertdialog')
      await waitFor(() => expect(client.getQueryState(errorKey)?.status).toBe('error'))
      await waitFor(() => expect(client.getQueryState(refetchKey)?.status).toBe('error'))
      await waitFor(() => expect(reportBReads).toBe(1))
      const errorQuery = client.getQueryCache().find({ queryKey: errorKey, exact: true })
      const errorGeneration = client.getQueryState(errorKey)?.errorUpdateCount
      const refetchQuery = client.getQueryCache().find({ queryKey: refetchKey, exact: true })
      const refetchErrorGeneration = client.getQueryState(refetchKey)?.errorUpdateCount
      expect(within(dialog).getByText(/Could not verify permissions for a.txt/)).toBeTruthy()
      expect(within(dialog).getByText(/Could not verify permissions for b.txt/)).toBeTruthy()

      await act(async () => {
        void client.refetchQueries({ exact: true, queryKey: refetchKey })
      })
      await waitFor(() => expect(reportBReads).toBe(2))

      const pendingDialog = screen.getByRole('alertdialog')
      expect(pendingDialog).toBe(dialog)
      expect(within(pendingDialog).getByText(/Could not verify permissions for a.txt/)).toBeTruthy()
      expect(within(pendingDialog).getByText(/Could not verify permissions for b.txt/)).toBeTruthy()
      expect(
        within(pendingDialog).getByRole('status', { name: 'Checking permissions for b.txt' })
      ).toBeTruthy()
      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(client.getQueryCache().find({ queryKey: errorKey, exact: true })).toBe(errorQuery)
      expect(client.getQueryState(errorKey)?.errorUpdateCount).toBe(errorGeneration)
      expect(client.getQueryCache().find({ queryKey: refetchKey, exact: true })).toBe(refetchQuery)
      expect(client.getQueryState(refetchKey)?.errorUpdateCount).toBe(refetchErrorGeneration)
      expect(client.getQueryState(refetchKey)?.fetchStatus).toBe('fetching')

      await act(async () => {
        releaseRefresh(heldPermissionResponse(['read', 'write', 'delete']))
        await refresh
      })
      await waitFor(() => expect(client.getQueryState(refetchKey)?.status).toBe('success'))
      expect(screen.getByRole('alertdialog')).toBe(dialog)
      expect(within(dialog).getByText(/Could not verify permissions for a.txt/)).toBeTruthy()
      expect(within(dialog).queryByRole('status')).toBeNull()
      expect(affordances.mock.calls.filter(([id]) => id === 'child-b')).toHaveLength(2)
    } finally {
      releaseRefresh(heldPermissionResponse(['read', 'write', 'delete']))
      client.clear()
    }
  })

  it.each(['success', 'failure'] as const)(
    'projects a current-folder refetch inside the Files permission dialog (%s)',
    async outcome => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const report = childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      })
      const children = await listChildrenPage([report])
      let folderReads = 0
      let releaseFolder!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
      let rejectFolder!: (error: Error) => void
      const pendingFolder = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
        (resolve, reject) => {
          releaseFolder = resolve
          rejectFolder = reject
        }
      )
      const folderError = await affordancesFailureMessage(
        429,
        { code: 'rate_limited', message: 'Too Many Requests' },
        'folder-active'
      )
      const rowError = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'child-report'
      )
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'folder-active') {
          folderReads += 1
          if (folderReads === 1 || outcome === 'failure') throw new Error(folderError)
          return pendingFolder
        }
        if (resourceId === 'child-report') throw new Error(rowError)
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const folderKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      const rowKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'child-report',
        'main',
        0
      )
      try {
        render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
        const dialog = await screen.findByRole('alertdialog')
        await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('error'))
        await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
        expect(
          within(dialog).getByText(/Too many file requests\. Wait before retrying permissions/)
        ).toBeTruthy()
        expect(
          within(dialog).getByText(/Could not verify permissions for report\.txt/)
        ).toBeTruthy()
        const folderQuery = client.getQueryCache().find({ exact: true, queryKey: folderKey })
        const rowQuery = client.getQueryCache().find({ exact: true, queryKey: rowKey })
        const folderGeneration = client.getQueryState(folderKey)?.errorUpdateCount
        const rowGeneration = client.getQueryState(rowKey)?.errorUpdateCount

        await act(async () => {
          void client.refetchQueries({ exact: true, queryKey: folderKey })
        })
        await waitFor(() => expect(folderReads).toBe(2))
        if (outcome === 'success') {
          await waitFor(() => expect(client.getQueryState(folderKey)?.fetchStatus).toBe('fetching'))
          expect(screen.getByRole('alertdialog')).toBe(dialog)
          expect(
            within(dialog).getByRole('status', { name: 'Checking permissions for Reports' })
          ).toBeTruthy()
          expect(
            within(dialog).getByText(/Could not verify permissions for report\.txt/)
          ).toBeTruthy()
          expect(client.getQueryState(folderKey)?.errorUpdateCount).toBe(folderGeneration)
          expect(client.getQueryState(rowKey)?.errorUpdateCount).toBe(rowGeneration)
          expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(
            folderQuery
          )
          expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
          expect(affordances.mock.calls.filter(([id]) => id === 'folder-active')).toHaveLength(2)
          expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(1)

          await act(async () => {
            releaseFolder(heldPermissionResponse(['read', 'write', 'delete']))
            await pendingFolder
          })
          await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('success'))
          expect(screen.getByRole('alertdialog')).toBe(dialog)
          expect(within(dialog).queryByRole('status')).toBeNull()
          expect(
            within(dialog).queryByText(/Too many file requests\. Wait before retrying permissions/)
          ).toBeNull()
          expect(
            within(dialog).getByText(/Could not verify permissions for report\.txt/)
          ).toBeTruthy()
        } else {
          await waitFor(() => expect(client.getQueryState(folderKey)?.fetchStatus).toBe('idle'))
          await waitFor(() =>
            expect(client.getQueryState(folderKey)?.errorUpdateCount).toBeGreaterThan(
              folderGeneration ?? 0
            )
          )
          expect(screen.getByRole('alertdialog')).toBe(dialog)
          expect(within(dialog).queryByRole('status')).toBeNull()
          expect(
            within(dialog).getByText(/Too many file requests\. Wait before retrying permissions/)
          ).toBeTruthy()
          expect(
            within(dialog).getByText(/Could not verify permissions for report\.txt/)
          ).toBeTruthy()
          expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(
            folderQuery
          )
          expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
          expect(client.getQueryState(rowKey)?.errorUpdateCount).toBe(rowGeneration)
        }
      } finally {
        releaseFolder(heldPermissionResponse(['read', 'write', 'delete']))
        client.clear()
      }
    }
  )

  it.each(['same-commit', 'staggered'] as const)(
    'aggregates distinct child-row permission failures without row Retry controls (%s)',
    async completionOrder => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const reportA = childView('child-a', 'a.txt', 'file', { parentResourceId: 'folder-active' })
      const reportB = childView('child-b', 'b.txt', 'file', { parentResourceId: 'folder-active' })
      const children = await listChildrenPage([reportA, reportB])
      let rejectSecond: (error: Error) => void = () => undefined
      const deniedA = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'child-a'
      )
      const deniedB = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'child-b'
      )
      const secondPermissionCheck =
        completionOrder === 'staggered'
          ? new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>((_resolve, reject) => {
              rejectSecond = reject
            })
          : null
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'child-a') throw new Error(deniedA)
        if (resourceId === 'child-b') {
          if (completionOrder === 'same-commit') throw new Error(deniedB)
          return secondPermissionCheck as Promise<
            Awaited<ReturnType<typeof heldPermissionResponse>>
          >
        }
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      try {
        const { container } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
          wrapper: wrapper(client),
        })
        await screen.findByRole('button', { name: 'Options for b.txt' })
        expect(
          container.querySelector('.da-gfs-list__name .da-permission-status-indicator')
        ).toBeNull()
        expect(container.querySelector('.da-gfs-list__name .da-permission-status-slot')).toBeNull()
        const dialog = await screen.findByRole('alertdialog')
        await waitFor(() =>
          expect(
            client.getQueryState(
              desktopQueryKeys.gfsAffordances(
                'test-environment:user-1:team-1',
                'child-a',
                'main',
                0
              )
            )?.status
          ).toBe('error')
        )
        expect(within(dialog).getByText(/Could not verify permissions for a\.txt/)).toBeTruthy()
        expect(
          container.querySelector('.da-gfs-list__name .da-permission-status-indicator')
        ).toBeNull()
        expect(container.querySelector('.da-gfs-list__name .da-permission-status-slot')).toBeNull()
        if (completionOrder === 'staggered') {
          expect(within(dialog).queryByText(/Could not verify permissions for b\.txt/)).toBeNull()
          await act(async () => {
            rejectSecond(new Error(deniedB))
            await secondPermissionCheck?.catch(() => undefined)
          })
        } else {
          await waitFor(() =>
            expect(
              client.getQueryState(
                desktopQueryKeys.gfsAffordances(
                  'test-environment:user-1:team-1',
                  'child-b',
                  'main',
                  0
                )
              )?.status
            ).toBe('error')
          )
        }
        const aggregate = await screen.findByRole('alertdialog')
        expect(aggregate).toBe(dialog)
        expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
        expect(within(aggregate).getByText(/Could not verify permissions for a\.txt/)).toBeTruthy()
        expect(within(aggregate).getByText(/Could not verify permissions for b\.txt/)).toBeTruthy()
        expect(
          within(aggregate).queryByRole('button', { name: 'Retry permission check' })
        ).toBeNull()
        expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
        expect(affordances.mock.calls.filter(([id]) => id === 'child-a')).toHaveLength(1)
        expect(affordances.mock.calls.filter(([id]) => id === 'child-b')).toHaveLength(1)
      } finally {
        if (completionOrder === 'staggered') rejectSecond(new Error(deniedB))
        client.clear()
      }
    }
  )

  it('keeps a dismissed Files row failure acknowledged after a same-Query remount', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    let reportReads = 0
    let folderResolveCalls = 0
    let releaseSeed!: () => void
    const seedResolution = new Promise<void>(resolve => {
      releaseSeed = resolve
    })
    let rejectRemount!: (error: Error) => void
    const remountRefresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (_resolve, reject) => {
        rejectRemount = reject
      }
    )
    const remountRefreshOutcome = remountRefresh.then(
      value => ({ kind: 'fulfilled' as const, value }),
      error => ({ kind: 'rejected' as const, error })
    )
    let remountRefreshOutcomeObserved = false
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      }
      reportReads += 1
      if (reportReads === 1)
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      if (reportReads === 2) return Promise.reject(new Error(denied))
      if (reportReads === 3) return remountRefresh
      return Promise.reject(new Error(denied))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => {
            folderResolveCalls += 1
            if (folderResolveCalls === 2) await seedResolution
            return folder
          }),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(reportReads).toBe(1))
      const queryIdentity = client.getQueryCache().find({ queryKey: rowKey, exact: true })
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dialog = await screen.findByRole('alertdialog')
      const errorGeneration = client.getQueryState(rowKey)?.errorUpdateCount
      expect(client.getQueryState(rowKey)?.data).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

      view.unmount()
      await act(async () => {
        await Promise.resolve()
      })
      view = render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await waitFor(() => expect(folderResolveCalls).toBe(2))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      await act(async () => {
        releaseSeed()
        await seedResolution
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(reportReads).toBe(3))
      expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')
      expect(client.getQueryState(rowKey)?.errorUpdateCount).toBe(errorGeneration)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(queryIdentity)
      await act(async () => {
        rejectRemount(new Error(denied))
        const outcome = await remountRefreshOutcome
        remountRefreshOutcomeObserved = true
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') throw new Error('Expected the remount producer to fail')
        expect(outcome.error).toBeInstanceOf(Error)
        expect((outcome.error as Error).message).toBe(denied)
      })
      await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(queryIdentity)
      expect(client.getQueryState(rowKey)?.errorUpdateCount).toBeGreaterThan(errorGeneration ?? 0)
      expect(reportReads).toBe(3)
    } finally {
      releaseSeed()
      if (!remountRefreshOutcomeObserved) {
        const cleanupSignal = new Error('test cleanup sentinel')
        rejectRemount(cleanupSignal)
        const outcome = await remountRefreshOutcome
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected')
          throw new Error('Expected cleanup to settle remount producer')
        expect(outcome.error).toBe(cleanupSignal)
      }
      view?.unmount()
      client.clear()
    }
  })

  it('preserves a dismissed row failure across folder departure and return', async () => {
    const folderA = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const folderD = childView('folder-destination', 'Archive', 'directory', {
      parentResourceId: 'folder-active',
    })
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const folderAChildren = await listChildrenPage([folderD, report])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    let rowReads = 0
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') {
        rowReads += 1
        if (rowReads > 1) throw new Error(denied)
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const listChildren = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folder-active') return folderAChildren
      throw new Error('Archive listing temporarily unavailable')
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folderA),
          listChildren,
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBe(1))
      const queryIdentity = client.getQueryCache().find({ queryKey: rowKey, exact: true })
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dismissedDialog = await screen.findByRole('alertdialog')
      expect(client.getQueryState(rowKey)?.status).toBe('error')
      fireEvent.click(within(dismissedDialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      await waitFor(() =>
        expect(
          listChildren.mock.calls.some(([resourceId]) => resourceId === 'folder-destination')
        ).toBe(true)
      )
      expect(screen.queryByRole('alertdialog')).toBeNull()
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'File location' })).getByRole('button', {
          name: 'Reports',
        })
      )
      await screen.findByRole('button', { name: 'Options for report.txt' })
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(queryIdentity)

      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(rowReads).toBe(4)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(queryIdentity)
    } finally {
      client.clear()
    }
  })

  it('preserves acknowledgement through an incomplete child cursor chain', async () => {
    const folderA = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const completePage = await listChildrenPage([report])
    const incompleteFirstPage = await listChildrenPage([], 'cursor-next')
    const completeSecondPage = await listChildrenPage([report])
    const omittedPage = await listChildrenPage([])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    let listingMode: 'initial' | 'incomplete' | 'omitted' | 'reappeared' = 'initial'
    let rowReads = 0
    let recovered = false
    const listChildren = vi.fn(async (_resourceId: string, _drive: string, cursor?: string) => {
      if (listingMode === 'incomplete') {
        return cursor === 'cursor-next' ? completeSecondPage : incompleteFirstPage
      }
      if (listingMode === 'omitted') return omittedPage
      return completePage
    })
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') {
        rowReads += 1
        if (rowReads > 1 && !recovered) throw new Error(denied)
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folderA),
          listChildren,
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const sessionScope = 'test-environment:user-1:team-1'
    const rowKey = desktopQueryKeys.gfsAffordances(sessionScope, 'child-report', 'main', 0)
    const folderKey = desktopQueryKeys.gfsChildren(sessionScope, 'folder-active', 'main', 0)
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBe(1))
      const rowQuery = client.getQueryCache().find({ queryKey: rowKey, exact: true })
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dismissedDialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dismissedDialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

      listingMode = 'incomplete'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      expect(client.getQueryState(folderKey)?.status).toBe('success')
      expect(listChildren).toHaveBeenCalledTimes(2)
      expect(client.getQueryData(folderKey)).toMatchObject({
        pages: [{ items: [], nextCursor: 'cursor-next' }],
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Options for report.txt' })).toBeNull()
      )
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBeGreaterThan(2))
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(rowQuery)
      expect(screen.queryByRole('alertdialog')).toBeNull()

      listingMode = 'omitted'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      expect(client.getQueryState(folderKey)?.status).toBe('success')
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Options for report.txt' })).toBeNull()
      )

      listingMode = 'reappeared'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(rowQuery)
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()

      recovered = true
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(client.getQueryState(rowKey)?.status).toBe('success')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      recovered = false
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
    } finally {
      client.clear()
    }
  })

  it('defers and restores a Files permission alert around the existing Rename form', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const reportA = childView('child-rename', 'rename.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const reportB = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([reportA, reportB])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    let reportReads = 0
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      }
      reportReads += 1
      return reportReads === 1
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.reject(new Error(denied))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const renameResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for rename.txt' })
      fireEvent.click(screen.getByRole('button', { name: 'Options for rename.txt' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
      const renameForm = await screen.findByRole('form', { name: 'Rename resource' })
      expect(renameResource).not.toHaveBeenCalled()

      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
      expect(renameForm.isConnected).toBe(true)
      expect(screen.queryByRole('alertdialog')).toBeNull()

      fireEvent.click(within(renameForm).getByRole('button', { name: 'Cancel rename' }))
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
      expect(screen.getByText(/Could not verify permissions for report.txt/)).toBeTruthy()
      expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
      expect(renameResource).not.toHaveBeenCalled()
      expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(2)
    } finally {
      client.clear()
    }
  })

  it('suspends an already visible Files permission alert while Rename takes focus', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const reportA = childView('child-rename', 'rename.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const reportB = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([reportA, reportB])
    const deniedB = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') throw new Error(deniedB)
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const renameResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for rename.txt' })
      const permissionDialog = await screen.findByRole('alertdialog')
      expect(
        within(permissionDialog).getByText(/Could not verify permissions for report\.txt/)
      ).toBeTruthy()

      // Model the existing action continuation winning after the permission dialog has committed.
      fireEvent.click(screen.getByRole('button', { name: 'Options for rename.txt' }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Actions for rename.txt' })).getByRole('menuitem', {
          name: 'Rename',
        })
      )
      const renameForm = await screen.findByRole('form', { name: 'Rename resource' })
      await waitFor(() => expect(document.activeElement?.closest('form')).toBe(renameForm))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.queryByRole('dialog', { name: 'Rename rename.txt' })).toBeNull()
      expect(renameResource).not.toHaveBeenCalled()

      fireEvent.click(within(renameForm).getByRole('button', { name: 'Cancel rename' }))
      const restoredDialog = await screen.findByRole('alertdialog')
      expect(restoredDialog).toBeTruthy()
      expect(within(restoredDialog).getByRole('button', { name: 'Close' })).toBe(
        document.activeElement
      )
      expect(
        within(restoredDialog).getByText(/Could not verify permissions for report\.txt/)
      ).toBeTruthy()
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
      expect(renameResource).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  })

  it('revalidates an expired row permission through the rendered action menu', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') reportPermissionReads += 1
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()

    // Expiry alone is not a fetch trigger. Opening the real menu mounts the
    // selected-row observer, which must refresh this exact resource first.
    vi.setSystemTime(Date.now() + 16_000)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
    })
    await waitFor(() => expect(reportPermissionReads).toBe(2))

    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
    })
    await waitFor(() => expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy())
    expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New name' })).toBeTruthy()
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('keeps a stale row action visible while its exact permission is rechecked on use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const denied = delegationAffordances(new Set(['read']), false)
    let denyPermissionCheck!: (value: Awaited<ReturnType<typeof delegationAffordances>>) => void
    const deniedPermission = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(
      resolve => {
        denyPermissionCheck = resolve
      }
    )
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(delegationAffordances(new Set(['read']), false))
      }
      reportPermissionReads += 1
      return reportPermissionReads === 2
        ? deniedPermission
        : Promise.resolve(delegationAffordances(new Set(['read', 'write']), false))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const { rerender } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))

    vi.setSystemTime(Date.now() + 16_000)
    rerender(<FilesPage pendingGfsUri={FOLDER_URI} />)
    expect(reportPermissionReads).toBe(1)
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    expect(screen.queryByText('Permissions will be checked when you use an action.')).toBeNull()
    expect(screen.queryByText('Checking permissions for report.txt…')).toBeNull()
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect(reportPermissionReads).toBe(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
    })
    await waitFor(() => expect(reportPermissionReads).toBe(2))
    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    const renameAction = within(menu).getByRole('menuitem', { name: 'Rename' })
    fireEvent.click(renameAction)
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    await act(async () => {
      denyPermissionCheck(denied)
      await deniedPermission
    })

    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename report.txt' })).toBeNull()
    )
    expect(renameResource).not.toHaveBeenCalled()
    expect(reportPermissionReads).toBe(2)
    client.clear()
  })

  it('waits for exact fresh row authority before opening a stale permission editor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let resolveRevalidation!: (value: Awaited<ReturnType<typeof delegationAffordances>>) => void
    const revalidation = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(resolve => {
      resolveRevalidation = resolve
    })
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(delegationAffordances(new Set(['read']), false))
      }
      reportPermissionReads += 1
      return reportPermissionReads === 2
        ? revalidation
        : Promise.resolve(delegationAffordances(new Set(['read', 'write']), false))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const reportKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    const { rerender } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))

    vi.setSystemTime(Date.now() + 16_000)
    rerender(<FilesPage pendingGfsUri={FOLDER_URI} />)
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    expect(reportPermissionReads).toBe(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rename report.txt' }))
    })
    await waitFor(() => expect(reportPermissionReads).toBe(2))
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    expect(client.getQueryState(reportKey)?.fetchStatus).toBe('fetching')
    expect(screen.queryByRole('status', { name: 'Checking permissions for report.txt' })).toBeNull()
    expect(document.querySelector('.da-gfs-list__name .da-permission-status-slot')).toBeNull()
    expect(renameResource).not.toHaveBeenCalled()

    await act(async () => {
      resolveRevalidation(delegationAffordances(new Set(['read', 'write']), false))
      await revalidation
    })
    expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy()
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('removes stale row actions after the exact resource is no longer found', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId !== 'child-report') {
        return delegationAffordances(new Set(['read']), false)
      }
      reportPermissionReads += 1
      if (reportPermissionReads > 1) {
        throw new Error('404 Not Found: resource unavailable httpStatus=404')
      }
      return delegationAffordances(new Set(['read', 'write']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const { rerender } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))
    vi.setSystemTime(Date.now() + 16_000)
    rerender(<FilesPage pendingGfsUri={FOLDER_URI} />)
    expect(reportPermissionReads).toBe(1)
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rename report.txt' }))
    await waitFor(() => expect(reportPermissionReads).toBe(2))
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename report.txt' })).toBeNull()
    )
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('refreshes invalidated row authority when FilesPage remounts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let reportPermissionReads = 0
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') {
        reportPermissionReads += 1
        return reportPermissionReads === 1
          ? delegationAffordances(new Set(['read', 'write', 'delete']), false)
          : delegationAffordances(new Set(['read']), false)
      }
      return delegationAffordances(new Set(['read']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource: vi.fn(async () => undefined),
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstMount = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()

    firstMount.unmount()
    await act(async () => {
      // Match the preview mutation's prefix invalidation while the row query is inactive.
      await client.invalidateQueries({ queryKey: desktopQueryKeys.gfsRoot })
    })
    vi.setSystemTime(Date.now() + 1_000)

    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByText('report.txt')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename report.txt' })).toBeNull()
    )
    expect(reportPermissionReads).toBe(2)
    client.clear()
  })

  it('reuses twenty row presentations on folder re-entry and rechecks one stale row on use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const nestedFolder = childView('nested-folder', 'Subfolder', 'directory', {
      parentResourceId: 'folder-active',
    })
    const reportsChildren = await listChildrenPage([nestedFolder])
    const rows = Array.from({ length: 20 }, (_, index) =>
      childView(`child-${index}`, `report-${index}.txt`, 'file', {
        parentResourceId: 'nested-folder',
      })
    )
    const nestedChildren = await listChildrenPage(rows)
    const rowReads = new Map<string, number>()
    const staleRowAnnouncementCount = () =>
      screen
        .getAllByRole('button', { name: /^Open report-\d+\.txt$/ })
        .filter(row =>
          within(row).queryByText('Permissions will be checked when you use an action.')
        ).length
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId.startsWith('child-')) {
        const reads = (rowReads.get(resourceId) ?? 0) + 1
        rowReads.set(resourceId, reads)
        if (resourceId === 'child-0' && reads > 1) {
          return delegationAffordances(new Set(['read']), false)
        }
      }
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    const listChildren = vi.fn(async (resourceId: string) =>
      resourceId === 'folder-active' ? reportsChildren : nestedChildren
    )
    const rootFolder = accessibleResource('folder-active', 'Reports', 'directory', {
      gfsUri: FOLDER_URI,
      permissions: ['read'],
      coversDescendants: true,
    })
    const accessible = await listAccessiblePage([rootFolder])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => accessible),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Reports' })
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }))
    await screen.findByRole('button', { name: 'Subfolder' })
    fireEvent.click(screen.getByRole('button', { name: 'Subfolder' }))
    await screen.findByText('report-0.txt')
    await waitFor(() => {
      expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(20)
    })
    expect(rowReads.size).toBe(20)
    expect([...rowReads.values()].every(reads => reads === 1)).toBe(true)

    vi.setSystemTime(Date.now() + 16_000)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(20)
    expect(staleRowAnnouncementCount()).toBe(0)

    vi.setSystemTime(Date.now() + 20_000)
    const breadcrumbs = within(screen.getByRole('navigation', { name: 'File location' }))
    fireEvent.click(breadcrumbs.getByRole('button', { name: 'Reports' }))
    await screen.findByRole('button', { name: 'Subfolder' })
    fireEvent.click(screen.getByRole('button', { name: 'Subfolder' }))
    await screen.findByText('report-0.txt')
    expect(
      listChildren.mock.calls.filter(([resourceId]) => resourceId === 'nested-folder').length
    ).toBeGreaterThanOrEqual(2)
    expect(rowReads.size).toBe(20)
    expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(20)
    expect([...rowReads.values()].every(reads => reads === 1)).toBe(true)
    expect(staleRowAnnouncementCount()).toBe(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for report-0.txt' }))
    })
    const menu = screen.getByRole('menu', { name: 'Actions for report-0.txt' })
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
    })
    await waitFor(() => expect(rowReads.get('child-0')).toBe(2))
    expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(21)
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('keeps current-folder actions presented during a background permission refetch', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([])
    let permissionReads = 0
    let releaseRefresh!: (value: Awaited<ReturnType<typeof delegationAffordances>>) => void
    const refreshResult = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(
      resolve => {
        releaseRefresh = resolve
      }
    )
    const permissions = delegationAffordances(
      new Set(['read', 'write', 'delete', 'manage_acl']),
      false
    )
    const affordances = vi.fn(() => {
      permissionReads += 1
      return permissionReads === 1 ? Promise.resolve(permissions) : refreshResult
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(permissionReads).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))

    await act(async () => {
      void client.refetchQueries({
        exact: true,
        queryKey: desktopQueryKeys.gfsAffordances(
          'test-environment:user-1:team-1',
          'folder-active',
          'main',
          0
        ),
      })
    })
    await waitFor(() => expect(permissionReads).toBe(2))

    const menu = screen.getByRole('menu', { name: 'Actions for Reports' })
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'New folder' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()

    await act(async () => {
      releaseRefresh(permissions)
      await refreshResult
    })
    expect(
      within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
        name: 'Rename',
      })
    ).toBeTruthy()
    client.clear()
  })

  it('keeps child-row Move presented while its current-folder authority refresh is pending', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const permissionResponse = heldPermissionResponse(['read', 'write', 'delete'])
    let folderReads = 0
    let releaseFolderRefresh!: (value: typeof permissionResponse) => void
    const folderRefresh = new Promise<typeof permissionResponse>(resolve => {
      releaseFolderRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'folder-active') return Promise.resolve(permissionResponse)
      folderReads += 1
      return folderReads === 1 ? Promise.resolve(permissionResponse) : folderRefresh
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByText('report.txt')
      await waitFor(() => expect(folderReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
      expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()

      await act(async () => {
        void client.refetchQueries({
          exact: true,
          queryKey: desktopQueryKeys.gfsAffordances(
            'test-environment:user-1:team-1',
            'folder-active',
            'main',
            0
          ),
        })
      })
      await waitFor(() => expect(folderReads).toBe(2))

      const pendingMenu = screen.getByRole('menu', { name: 'Actions for report.txt' })
      expect(within(pendingMenu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
      fireEvent.click(within(pendingMenu).getByRole('menuitem', { name: 'Move to' }))
      expect(screen.queryByRole('dialog', { name: 'Move file report.txt' })).toBeNull()

      await act(async () => {
        releaseFolderRefresh(permissionResponse)
        await folderRefresh
      })
      expect(await screen.findByRole('dialog', { name: 'Move file report.txt' })).toBeTruthy()
    } finally {
      await act(async () => {
        releaseFolderRefresh(permissionResponse)
        await Promise.resolve()
      })
      client.clear()
    }
  })

  it('keeps current-folder Move presented while its source-parent authority refresh is pending', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const sourceParent = await resolveResource(resolvedDirectory('source-parent', 'Shared folder'))
    const children = await listChildrenPage([])
    const permissionResponse = heldPermissionResponse(['read', 'write', 'delete'])
    let sourceParentReads = 0
    let releaseSourceParentRefresh!: (value: typeof permissionResponse) => void
    const sourceParentRefresh = new Promise<typeof permissionResponse>(resolve => {
      releaseSourceParentRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'source-parent') return Promise.resolve(permissionResponse)
      sourceParentReads += 1
      return sourceParentReads === 1 ? Promise.resolve(permissionResponse) : sourceParentRefresh
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? folder : sourceParent)),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(sourceParentReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      const menu = screen.getByRole('menu', { name: 'Actions for Reports' })
      expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()

      await act(async () => {
        void client.refetchQueries({
          exact: true,
          queryKey: desktopQueryKeys.gfsAffordances(
            'test-environment:user-1:team-1',
            'source-parent',
            'main',
            0
          ),
        })
      })
      await waitFor(() => expect(sourceParentReads).toBe(2))

      const pendingMenu = screen.getByRole('menu', { name: 'Actions for Reports' })
      expect(within(pendingMenu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
      fireEvent.click(within(pendingMenu).getByRole('menuitem', { name: 'Move to' }))
      expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()

      await act(async () => {
        releaseSourceParentRefresh(permissionResponse)
        await sourceParentRefresh
      })
      expect(await screen.findByRole('dialog', { name: 'Move folder Reports' })).toBeTruthy()
    } finally {
      await act(async () => {
        releaseSourceParentRefresh(permissionResponse)
        await Promise.resolve()
      })
      client.clear()
    }
  })

  it.each([
    { missing: 'write', held: ['read', 'delete'] },
    { missing: 'delete', held: ['read', 'write'] },
  ])(
    'does not open Move when fresh source-parent authority lacks $missing',
    async ({ missing, held }) => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', {
          gfsUri: FOLDER_URI,
          parentResourceId: 'source-parent',
        })
      )
      const sourceParent = await resolveResource(
        resolvedDirectory('source-parent', 'Shared folder')
      )
      const children = await listChildrenPage([])
      const destinations = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', { permissions: ['read'] }),
      ])
      let currentSourceBits = ['read', 'write', 'delete']
      const produceAffordances = appServiceAffordanceProducer(resourceId =>
        Promise.resolve(
          heldPermissionResponse(
            resourceId === 'source-parent' ? currentSourceBits : ['read', 'write', 'delete']
          )
        )
      )
      const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
      const moveResource = vi.fn(async () => undefined)
      const pushToast = vi.fn()
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => destinations),
            resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? folder : sourceParent)),
            listChildren: vi.fn(async () => children),
            affordances,
            moveResource,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      try {
        render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
          wrapper: wrapper(client),
        })
        await screen.findByRole('button', { name: 'Options for Reports' })
        const sourceParentKey = desktopQueryKeys.gfsAffordances(
          'test-environment:user-1:team-1',
          'source-parent',
          'main',
          0
        )
        await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
        fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
        expect(await screen.findByRole('menuitem', { name: 'Move to' })).toBeTruthy()

        await act(async () => {
          await client.invalidateQueries({
            exact: true,
            queryKey: sourceParentKey,
            refetchType: 'none',
          })
        })
        currentSourceBits = held
        fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' }))

        await waitFor(() =>
          expect(pushToast).toHaveBeenCalledWith(
            `You do not have ${missing} access to the source folder.`,
            'error'
          )
        )
        expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()
        expect(moveResource).not.toHaveBeenCalled()
      } finally {
        client.clear()
      }
    }
  )

  it('does not grant a role bit removed from fresh authority at submit time', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([])
    let currentHeldBits = ['read', 'write', 'manage_acl']
    const produceAffordances = appServiceAffordanceProducer(() =>
      Promise.resolve(heldPermissionResponse(currentHeldBits))
    )
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const grant = vi.fn(async () => undefined)
    const listGrants = vi.fn(async () => [])
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: {
          listMine: vi.fn(async () => [
            {
              name: 'chatllm',
              contextRef: 'ctx-1',
              mcpServers: [],
              gfsSubject: { type: 'host', id: '1st:mcp-host/chatllm' },
            },
          ]),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          listGrants,
          listShares: vi.fn(async () => []),
          listInheritedAccess: vi.fn(async () => ({ items: [], nextCursor: null })),
          grant,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Options for Reports' })
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: /^Share$/ }))
      const shareMenu = await screen.findByRole('menu', { name: 'Share options for Reports' })
      fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
      await screen.findByRole('dialog', { name: 'Share folder Reports' })

      const picker = await screen.findByRole('combobox', {
        name: 'Add people, teams, or agents',
      })
      fireEvent.focus(picker)
      fireEvent.click(await screen.findByRole('option', { name: /chatllm/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Access role for selected recipients' }))
      fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
      await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))

      const permissionKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      await act(async () => {
        await client.invalidateQueries({
          exact: true,
          queryKey: permissionKey,
          refetchType: 'none',
        })
      })
      currentHeldBits = ['read', 'manage_acl']
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Share folder Reports' })).getByRole('button', {
          name: 'Share',
        })
      )

      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith('You can no longer grant write on Reports.', 'error')
      )
      expect(grant).not.toHaveBeenCalled()
      expect(listGrants).toHaveBeenCalledTimes(1)
      expect(pushToast).not.toHaveBeenCalledWith('Access granted to 1 subject', 'success')
    } finally {
      client.clear()
    }
  })

  it('denies Files Move without destination write even when the source parent permits it', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const sourceParent = await resolveResource(resolvedDirectory('source-parent', 'Shared folder'))
    const destinations = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', { permissions: ['read'] }),
    ])
    const children = await listChildrenPage([])
    const produceAffordances = appServiceAffordanceProducer(resourceId =>
      resourceId === 'source-parent'
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.resolve(heldPermissionResponse(['read']))
    )
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => destinations),
          resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? folder : sourceParent)),
          listChildren: vi.fn(async () => children),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move folder Reports' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('You do not have write access to the destination folder.')
    ).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith('destination-1', 'main')
    expect(moveResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('uses the current folder parent for Move and does not show an idle denial', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([])
    const permissions = vi.fn(async (resourceId: string) =>
      resourceId === 'source-parent'
        ? delegationAffordances(new Set(['read', 'write', 'delete']), false)
        : delegationAffordances(new Set(['read']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances: permissions,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(permissions).toHaveBeenCalledWith('source-parent', 'main'))

    expect(
      screen.queryByText(/Move is unavailable because you need write and delete access/)
    ).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    })
    expect(
      within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
        name: 'Move to',
      })
    ).toBeTruthy()
    client.clear()
  })

  it('keeps the source-parent Move candidate and reports bounded 429 retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([])
    let sourceParentReads = 0
    let rejectAutomaticRefetch!: (error: Error) => void
    const pendingAutomaticRefetch = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (_resolve, reject) => {
        rejectAutomaticRefetch = reject
      }
    )
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'source-parent'
    )
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'source-parent') {
        sourceParentReads += 1
        if (sourceParentReads === 2) return Promise.reject(rateLimited)
        if (sourceParentReads === 3) return pendingAutomaticRefetch
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
      wrapper: wrapper(client),
    })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(sourceParentReads).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    expect(
      within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
        name: 'Move to',
      })
    ).toBeTruthy()

    const sourceKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'source-parent',
      'main',
      0
    )
    await act(async () => {
      await client.refetchQueries({ exact: true, queryKey: sourceKey })
    })
    await waitFor(() => expect(sourceParentReads).toBe(2))

    const sourceError = String(client.getQueryState(sourceKey)?.error)
    expect(sourceError).toContain('httpStatus=429')
    expect(sourceError).toContain('retryAfterSeconds=7')
    expect(screen.getAllByText(/Could not verify Move permissions:/)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    const menuAfterError = screen.queryByRole('menu', { name: 'Actions for Reports' })
    const moveItem = menuAfterError
      ? within(menuAfterError).queryByRole('menuitem', { name: 'Move to' })
      : null
    expect(moveItem).toBeTruthy()
    if (moveItem) fireEvent.click(moveItem)
    expect
      .soft(pushToast)
      .toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
    expect(moveResource).not.toHaveBeenCalled()
    expect(sourceParentReads).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    await waitFor(() =>
      expect(pushToast).toHaveBeenLastCalledWith(
        'Too many file requests — try again in 7s.',
        'error'
      )
    )
    expect(sourceParentReads).toBe(2)
    expect(moveResource).not.toHaveBeenCalled()

    let automaticRequest!: Promise<void>
    act(() => {
      automaticRequest = client.refetchQueries({ exact: true, queryKey: sourceKey })
      expect(client.getQueryState(sourceKey)?.fetchStatus).toBe('fetching')
      expect(screen.getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      expect(sourceParentReads).toBe(3)
      const retryQuery = client.getQueryCache().find({ queryKey: sourceKey, exact: true })
      expect(
        isPermissionErrorAcknowledged({
          id: 'source-parent-retry',
          message: 'Too many file requests',
          queryIdentity: retryQuery,
          errorUpdateCount: retryQuery?.state.errorUpdateCount,
        })
      ).toBe(false)
      expect(pushToast).toHaveBeenLastCalledWith(
        'Too many file requests — try again in 7s.',
        'error'
      )
    })
    await act(async () => {
      rejectAutomaticRefetch(rateLimited)
      await automaticRequest
    })
    await waitFor(() => expect(client.getQueryState(sourceKey)?.fetchStatus).toBe('idle'))
    expect(screen.getByText(/Could not verify Move permissions:/)).toBeTruthy()

    vi.setSystemTime(Date.now() + 7_000)
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    await waitFor(() => expect(sourceParentReads).toBe(4))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()
    expect(moveResource).not.toHaveBeenCalled()

    client.clear()
  })

  it('does not acknowledge a committed Retry after its source-parent Query is replaced', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([])
    let sourceParentReads = 0
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'source-parent'
    )
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'source-parent') {
        sourceParentReads += 1
        if (sourceParentReads === 2) return Promise.reject(rateLimited)
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances: vi.fn((resourceId: string) => produceAffordances(resourceId)),
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const sourceKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'source-parent',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(sourceParentReads).toBe(1))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: sourceKey })
      })
      await screen.findByText(/Could not verify Move permissions:/)
      const originalQuery = client.getQueryCache().find({ exact: true, queryKey: sourceKey })
      expect(originalQuery).toBeDefined()
      const committedError: PermissionErrorItem = {
        id: 'committed-source-parent-error',
        message: 'Could not verify Move permissions',
        queryIdentity: originalQuery,
        errorUpdateCount: originalQuery?.state.errorUpdateCount,
      }
      const committedToken = permissionErrorToken(committedError)
      expect(committedToken).toBeDefined()
      committedError.token = committedToken
      expect(isPermissionErrorAcknowledged(committedError)).toBe(false)
      const committedRetry = screen.getByRole('button', { name: 'Retry permission check' })
      const replacementData = await heldPermissionResponse(['read', 'write', 'delete'])
      act(() => {
        client.removeQueries({ exact: true, queryKey: sourceKey })
        client.setQueryData(sourceKey, replacementData)
        client.invalidateQueries({ exact: true, queryKey: sourceKey, refetchType: 'none' })
        expect(committedRetry.isConnected).toBe(true)
        fireEvent.click(committedRetry)
      })
      expect(isPermissionErrorAcknowledged(committedError)).toBe(false)
    } finally {
      client.clear()
    }
  })

  it('keeps a child Move candidate visible after the current-folder check returns 429', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([
      childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'folder-active'
    )
    let rejectCurrentCheck = false
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'folder-active' && rejectCurrentCheck) {
        rejectCurrentCheck = false
        return Promise.reject(rateLimited)
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('folder-active', 'main'))

      const currentFolderKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      rejectCurrentCheck = true
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: currentFolderKey })
      })
      await waitFor(() => expect(client.getQueryState(currentFolderKey)?.status).toBe('error'))
      expect(String(client.getQueryState(currentFolderKey)?.error)).toContain('httpStatus=429')

      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      const moveItem = within(
        screen.getByRole('menu', { name: 'Actions for report.txt' })
      ).getByRole('menuitem', { name: 'Move to' })
      expect(moveItem).toBeTruthy()
      fireEvent.click(moveItem)
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
      )
      expect(screen.queryByRole('dialog', { name: 'Move file report.txt' })).toBeNull()
      expect(moveResource).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  })

  it('keeps the latest Move target when source checks finish out of order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([
      childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const accessible = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    let deferSourceParentCheck = false
    const sourceParentCheckRelease: { current: (() => void) | null } = { current: null }
    let markSourceParentCheckStarted!: () => void
    let markSourceParentCheckFinished!: () => void
    const sourceParentCheckStarted = new Promise<void>(resolve => {
      markSourceParentCheckStarted = resolve
    })
    const sourceParentCheckFinished = new Promise<void>(resolve => {
      markSourceParentCheckFinished = resolve
    })
    const sourceParentCheckGate = new Promise<void>(resolve => {
      sourceParentCheckRelease.current = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === 'source-parent' && deferSourceParentCheck) {
        deferSourceParentCheck = false
        markSourceParentCheckStarted()
        await sourceParentCheckGate
        markSourceParentCheckFinished()
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => accessible),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async resourceId =>
            resourceId === 'folder-active' ? children : listChildrenPage([])
          ),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))

      vi.setSystemTime(Date.now() + 16_000)
      deferSourceParentCheck = true
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
          name: 'Move to',
        })
      )
      await sourceParentCheckStarted

      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Actions for report.txt' })).getByRole('menuitem', {
          name: 'Move to',
        })
      )
      expect(await screen.findByRole('dialog', { name: 'Move file report.txt' })).toBeTruthy()

      await act(async () => {
        sourceParentCheckRelease.current?.()
        await sourceParentCheckFinished
      })

      expect(screen.getByRole('dialog', { name: 'Move file report.txt' })).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()
      expect(moveResource).not.toHaveBeenCalled()
    } finally {
      sourceParentCheckRelease.current?.()
      client.clear()
    }
  })

  it('keeps an idle current-folder 503 out of the page alert surface (R8-L5)', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([
      childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const serviceFailure = await affordancesFailureMessage(
      503,
      { code: 'upstream_unavailable', message: 'private permission upstream detail' },
      'folder-active'
    )
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'folder-active') return Promise.reject(new Error(serviceFailure))
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      const currentKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      await waitFor(() => expect(client.getQueryState(currentKey)?.status).toBe('error'))

      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByText(/private permission upstream detail/)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
      expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    } finally {
      client.clear()
    }
  })

  it('shows a generic current-folder alert when an admitted 429 Retry fails with 503', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const tooManyRequests = await affordancesFailureMessage(
      429,
      { code: 'rate_limited', message: 'private throttle detail' },
      'folder-active'
    )
    const unavailable = await affordancesFailureMessage(
      503,
      { code: 'upstream_unavailable', message: 'private permission upstream detail' },
      'folder-active'
    )
    let currentReads = 0
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== 'folder-active') {
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      }
      currentReads += 1
      return Promise.reject(new Error(currentReads === 1 ? tooManyRequests : unavailable))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const currentKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'folder-active',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      const firstDialog = await screen.findByRole('alertdialog')
      expect(within(firstDialog).getByText(/Too many file requests/)).toBeTruthy()
      vi.setSystemTime(Date.now() + 61_000)
      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(currentReads).toBe(2))
      await waitFor(() => expect(client.getQueryState(currentKey)?.status).toBe('error'))

      const retryFailure = await screen.findByRole('alertdialog')
      expect(
        within(retryFailure).getByText(/Could not verify permissions for Reports/)
      ).toBeTruthy()
      expect(within(retryFailure).queryByText(/private permission upstream detail/)).toBeNull()
      expect(
        within(retryFailure).queryByRole('button', { name: 'Retry permission check' })
      ).toBeNull()
      expect(affordances).toHaveBeenCalledTimes(2)
    } finally {
      client.clear()
      vi.useRealTimers()
    }
  })

  it.each([403, 404])(
    'withholds current-folder permission actions after HTTP %i and preserves identity actions',
    async status => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const children = await listChildrenPage([])
      let currentPermissionReads = 0
      const denied = Object.assign(
        new Error(
          status === 403
            ? '403 Forbidden: resource_access_denied'
            : '404 Not Found: resource_not_found'
        ),
        { status }
      )
      const produceAffordances = appServiceAffordanceProducer(resourceId => {
        if (resourceId === 'folder-active') {
          currentPermissionReads += 1
          if (currentPermissionReads > 1) return Promise.reject(denied)
        }
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete', 'manage_acl']))
      })
      const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(currentPermissionReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))

      const menu = screen.getByRole('menu', { name: 'Actions for Reports' })
      const identityActions = () =>
        within(screen.getByRole('menu', { name: 'Share options for Reports' }))
          .getAllByRole('menuitem')
          .map(item => item.textContent?.trim())
          .filter(label => label === 'Copy link' || label === 'Copy folder ID')
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
      const identityActionsBefore = identityActions()
      expect(identityActionsBefore).toEqual(['Copy link', 'Copy folder ID'])
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
      expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()

      vi.setSystemTime(Date.now() + 16_000)
      const currentKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: currentKey })
      })
      await waitFor(() => expect(currentPermissionReads).toBe(2))
      expect(String(client.getQueryState(currentKey)?.error)).toContain(`httpStatus=${status}`)
      expect(screen.getByText(/Could not verify permissions for Reports:/)).toBeTruthy()
      expect(screen.queryByText(/resource_access_denied|resource_not_found/)).toBeNull()

      const currentMenu = screen.getByRole('menu', { name: 'Actions for Reports' })
      const actionsAfterDenial = within(currentMenu)
        .getAllByRole('menuitem')
        .map(item => item.textContent?.trim())
      expect(actionsAfterDenial).not.toContain('Rename')
      expect(actionsAfterDenial).not.toContain('New folder')
      expect(actionsAfterDenial).not.toContain('Upload file')
      expect(actionsAfterDenial).not.toContain('Delete')
      fireEvent.click(within(currentMenu).getByRole('menuitem', { name: 'Share' }))
      const shareMenu = screen.getByRole('menu', { name: 'Share options for Reports' })
      expect(within(shareMenu).queryByRole('menuitem', { name: 'Share' })).toBeNull()
      expect(identityActions()).toEqual(identityActionsBefore)
      client.clear()
    }
  )

  it('keeps a shared-with-me row actionable after its list permission goes stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const sharedFolder = accessibleResource('shared-folder', 'Shared folder', 'directory', {
      gfsUri: 'gfs://main/0123456789abcdef0123456789abcdef',
      path: '/Shared folder',
      permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
    })
    const accessiblePage = await listAccessiblePage([sharedFolder])
    const listAccessible = vi.fn(async () => accessiblePage)
    const affordances = vi.fn(async () =>
      delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={null} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Shared folder' })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Rename Shared folder' })).toBeTruthy()

    vi.setSystemTime(Date.now() + 16_000)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Shared folder' }))
    })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('shared-folder', 'main'))

    const menu = screen.getByRole('menu', { name: 'Actions for Shared folder' })
    expect.soft(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    client.clear()
  })

  it('shows one retryable source-parent error for shared rows and retries permission only', async () => {
    const sharedFiles = await listAccessiblePage([
      accessibleResource('shared-file-a', 'Shared A.txt', 'file', {
        parentResourceId: 'shared-source-parent',
        permissions: ['read'],
      }),
      accessibleResource('shared-file-b', 'Shared B.txt', 'file', {
        parentResourceId: 'shared-source-parent',
        permissions: ['read'],
      }),
    ])
    const sourceParentError = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'shared-source-parent'
    )
    let sourceParentReads = 0
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'shared-source-parent') {
        return Promise.resolve(heldPermissionResponse(['read']))
      }
      sourceParentReads += 1
      return sourceParentReads === 1
        ? Promise.reject(new Error(sourceParentError))
        : Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => sharedFiles),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={null} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Shared A.txt' })
      await screen.findByRole('button', { name: 'Options for Shared B.txt' })
      fireEvent.click(screen.getByRole('button', { name: 'Options for Shared A.txt' }))

      const sourceParentKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'shared-source-parent',
        'main',
        0
      )
      await waitFor(() => expect(sourceParentReads).toBe(1))
      await waitFor(() => expect(client.getQueryState(sourceParentKey)?.status).toBe('error'))
      const sourceParentCalls = () =>
        affordances.mock.calls.filter(([resourceId]) => resourceId === 'shared-source-parent')

      const permissionDialog = screen.getByRole('alertdialog', {
        name: 'Could not verify EvenDrive permissions',
      })
      expect(within(permissionDialog).getByText(/Could not verify Move permissions:/)).toBeTruthy()
      expect(screen.getByText(/Could not verify Move permissions:/)).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'Retry permission check' })).toHaveLength(1)
      const menu = screen.getByRole('menu', { name: 'Actions for Shared A.txt' })
      expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
      expect(moveResource).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(sourceParentReads).toBe(2))
      await waitFor(() => expect(client.getQueryState(sourceParentKey)?.status).toBe('success'))

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(sourceParentCalls()).toHaveLength(2)
      expect(sourceParentCalls()).toEqual([
        ['shared-source-parent', 'main'],
        ['shared-source-parent', 'main'],
      ])
      expect(
        within(screen.getByRole('menu', { name: 'Actions for Shared A.txt' })).getByRole(
          'menuitem',
          { name: 'Move to' }
        )
      ).toBeTruthy()
      expect(moveResource).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  })

  it('proves an errored Query refetch is not a fresh fetchQuery cache hit', async () => {
    const sourceKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'shared-source-parent',
      'main',
      0
    )
    const firstData = heldPermissionResponse(['read', 'write', 'delete'])
    const recoveredData = heldPermissionResponse(['read', 'write'])
    const temporaryError = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'Permission service unavailable' },
      'shared-source-parent'
    )
    let failNextRead = false
    const producer = vi.fn(async () => {
      if (failNextRead) {
        failNextRead = false
        throw temporaryError
      }
      return firstData
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      await client.fetchQuery({
        queryKey: sourceKey,
        queryFn: producer,
        staleTime: 15_000,
        retry: false,
      })
      const query = client.getQueryCache().find({ exact: true, queryKey: sourceKey })
      expect(query?.state.status).toBe('success')
      const successEvents: unknown[] = []
      const unsubscribe = client.getQueryCache().subscribe(event => {
        if (event.type === 'updated' && event.query === query && event.action.type === 'success') {
          successEvents.push(event)
        }
      })
      failNextRead = true
      await client.refetchQueries({ exact: true, queryKey: sourceKey })
      expect(producer).toHaveBeenCalledTimes(2)
      expect(query?.state.status).toBe('error')
      expect(query?.state.data).toBe(firstData)
      expect(query?.state.isInvalidated).toBe(true)
      expect(Date.now() - query!.state.dataUpdatedAt).toBeLessThan(15_000)
      expect(query?.isStaleByTime(15_000)).toBe(true)
      const failedDataUpdateCount = query?.state.dataUpdateCount ?? 0
      successEvents.length = 0

      const retryProducer = vi.fn(async () => recoveredData)
      const retryResult = await client.fetchQuery({
        queryKey: sourceKey,
        queryFn: retryProducer,
        staleTime: 15_000,
        retry: false,
      })
      expect(retryResult).toBe(recoveredData)
      expect(retryProducer).toHaveBeenCalledTimes(1)
      expect(query?.state.status).toBe('success')
      expect(query?.state.data).toEqual(recoveredData)
      expect(query?.state.dataUpdateCount).toBeGreaterThan(failedDataUpdateCount)
      expect(successEvents).toHaveLength(1)
      unsubscribe()
    } finally {
      client.clear()
    }
  })

  it('checks generated dormant-binding session histories with real Query and Files producers', async () => {
    type Model = {
      phase: 'g1-error' | 'g2-seed-pending' | 'g2-settled'
      observedPending: number
      observedSettled: number
      outcome: 'success' | 'failure'
    }
    type Real = {
      client: QueryClient
      scheduler: Scheduler
      seedOutcome: 'success' | 'failure'
      nextFolder: Awaited<ReturnType<typeof resolveResource>>
      releaseSeed: (result: Promise<Awaited<ReturnType<typeof resolveResource>>>) => void
      staleQueryKey: ReturnType<typeof desktopQueryKeys.gfsAffordances>
      transitionToG2: () => Promise<void>
      settleSeed: () => Promise<void>
    }

    class ObserveG1Error implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.phase === 'g1-error'
      }
      async run(): Promise<void> {
        expect(screen.getByRole('alertdialog')).toBeTruthy()
      }
      toString(): string {
        return 'observe the producer-backed G1 permission error before route departure'
      }
    }

    class TransitionToG2 implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.phase === 'g1-error'
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.transitionToG2()
        model.phase = 'g2-seed-pending'
        expect(
          state.client.getQueryCache().find({ exact: true, queryKey: state.staleQueryKey })
        ).toBeTruthy()
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(
          screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
        ).toBeNull()
      }
      toString(): string {
        return 'unmount Files, publish G2 while its controllers are absent, and remount on a held seed'
      }
    }

    class ObservePending implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.phase === 'g2-seed-pending'
      }
      async run(model: Model, state: Real): Promise<void> {
        expect(
          state.client.getQueryCache().find({ exact: true, queryKey: state.staleQueryKey })
        ).toBeTruthy()
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(
          screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
        ).toBeNull()
        model.observedPending += 1
      }
      toString(): string {
        return 'observe the dormant G1 Query while G2 Files seed is pending'
      }
    }

    class SettleSeed implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.phase === 'g2-seed-pending'
      }
      async run(model: Model, state: Real): Promise<void> {
        await new ObservePending().run(model, state)
        await state.settleSeed()
        model.phase = 'g2-settled'
      }
      toString(): string {
        return 'settle the G2 Files location producer under scheduler control'
      }
    }

    class ObserveSettled implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.phase === 'g2-settled'
      }
      async run(model: Model, state: Real): Promise<void> {
        expect(
          state.client.getQueryCache().find({ exact: true, queryKey: state.staleQueryKey })
        ).toBeTruthy()
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(
          screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
        ).toBeNull()
        model.observedSettled += 1
      }
      toString(): string {
        return 'compare the settled G2 Files view with the independent session-binding model'
      }
    }

    const historyArbitrary = fc.commands<Model, Real, true>(
      [
        fc.constantFrom(
          new ObserveG1Error(),
          new TransitionToG2(),
          new ObservePending(),
          new SettleSeed(),
          new ObserveSettled()
        ),
      ],
      { maxCommands: 12 }
    )
    const observedOutcomes = new Set<'success' | 'failure'>()

    await fc.assert(
      fc.asyncProperty(
        historyArbitrary,
        fc.constantFrom<'success' | 'failure'>('success', 'failure'),
        fc.scheduler(),
        async (scheduled, outcome, scheduler) => {
          observedOutcomes.add(outcome)
          const sourceFailure = await affordancesFailureMessage(
            503,
            { code: 'unavailable', message: 'permission service temporarily unavailable' },
            'source-parent'
          )
          const oldFolder = await resolveResource(
            resolvedDirectory('folder-old-team', 'Reports', {
              gfsUri: FOLDER_URI,
              parentResourceId: 'source-parent',
            })
          )
          const nextFolderUri = 'gfs://main/new-team-folder'
          const nextFolder = await resolveResource(
            resolvedDirectory('folder-new-team', 'Projects', { gfsUri: nextFolderUri })
          )
          let activeGeneration = 0
          let releaseSeed!: (result: Promise<typeof nextFolder>) => void
          const pendingSeed = new Promise<typeof nextFolder>(resolve => {
            releaseSeed = resolve
          })
          const resolve = vi.fn(async (uri: string) => {
            if (uri === FOLDER_URI) return oldFolder
            if (uri === nextFolderUri) return pendingSeed
            return resolveResource(
              resolvedDirectory('source-parent', 'Shared', {
                gfsUri: 'gfs://main/source-parent',
              })
            )
          })
          const affordances = vi.fn(async (resourceId: string) => {
            if (resourceId === 'source-parent' && activeGeneration === 0) {
              throw new Error(sourceFailure)
            }
            return heldPermissionResponse(['read', 'write', 'delete'])
          })
          Object.defineProperty(window, 'clerum', {
            configurable: true,
            value: {
              auth: { getSessionGeneration: vi.fn(async () => activeGeneration) },
              gfs: {
                listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
                resolve,
                listChildren: vi.fn(async () => listChildrenPage([])),
                affordances,
              },
            },
          })

          const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
          const staleQueryKey = desktopQueryKeys.gfsAffordances(
            'test-environment:user-1:team-1',
            'source-parent',
            'main',
            0
          )
          const nextSession = {
            ...authValue,
            me: { ...me, teamId: 'team-2', teamName: 'Team Two' },
            sessionGeneration: 1,
          } as unknown as AuthContextValue
          const renderSession = (auth: AuthContextValue, pendingGfsUri: string) => (
            <AuthContext.Provider value={auth}>
              <QueryClientProvider client={client}>
                <FilesPage pendingGfsUri={pendingGfsUri} />
              </QueryClientProvider>
            </AuthContext.Provider>
          )
          let oldPage: ReturnType<typeof render> | undefined
          let newPage: ReturnType<typeof render> | undefined
          const model: Model = {
            phase: 'g1-error',
            observedPending: 0,
            observedSettled: 0,
            outcome,
          }
          const real: Real = {
            client,
            scheduler,
            seedOutcome: outcome,
            nextFolder,
            releaseSeed,
            staleQueryKey,
            transitionToG2: async () => {
              if (!oldPage) throw new Error('Expected the old Files route to be mounted')
              oldPage.unmount()
              oldPage = undefined
              activeGeneration = 1
              newPage = render(renderSession(nextSession, nextFolderUri))
              await waitFor(() => expect(resolve).toHaveBeenCalledWith(nextFolderUri))
              await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
            },
            settleSeed: async () => {
              const result =
                outcome === 'success'
                  ? Promise.resolve(nextFolder)
                  : Promise.reject(new Error('new-team location seed failed'))
              releaseSeed(scheduler.schedule(result, 'G2 Files seed settlement'))
              await act(async () => scheduler.waitIdle())
              if (outcome === 'success') {
                await screen.findByRole('button', { name: 'Options for Projects' })
              }
              await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
              expect(
                screen.queryByRole('button', {
                  name: 'Permission check failed; open recovery options',
                })
              ).toBeNull()
            },
          }

          try {
            oldPage = render(renderSession(authValue, FOLDER_URI))
            await screen.findByText(/Could not verify Move permissions:/)
            expect(client.getQueryState(staleQueryKey)?.status).toBe('error')
            expect(screen.getByRole('alertdialog')).toBeTruthy()

            expect(model.phase).toBe('g1-error')
            await fc.asyncModelRun(() => ({ model, real }), scheduled)
            if (model.phase === 'g1-error') await new TransitionToG2().run(model, real)
            if (model.phase === 'g2-seed-pending') await new SettleSeed().run(model, real)
            if (model.observedSettled === 0) await new ObserveSettled().run(model, real)
            await waitFor(() =>
              expect(
                client
                  .getQueryCache()
                  .getAll()
                  .every(query => query.state.fetchStatus === 'idle')
              ).toBe(true)
            )

            expect(
              client.getQueryCache().find({ exact: true, queryKey: staleQueryKey })
            ).toBeTruthy()
            expect(screen.queryByRole('alertdialog')).toBeNull()
            expect(
              screen.queryByRole('button', {
                name: 'Permission check failed; open recovery options',
              })
            ).toBeNull()
          } finally {
            if (model.phase === 'g2-seed-pending') {
              releaseSeed(Promise.resolve(nextFolder))
              await act(async () => scheduler.waitIdle())
            }
            oldPage?.unmount()
            newPage?.unmount()
            client.clear()
          }
        }
      ),
      { numRuns: 24, seed: 142715 }
    )
    expect(observedOutcomes).toEqual(new Set(['success', 'failure']))
  })
})
