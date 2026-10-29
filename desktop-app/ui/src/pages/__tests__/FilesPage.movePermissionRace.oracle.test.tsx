// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastStack } from '@components/Common/ToastStack'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useToastController } from '@hooks/domain/useToastController'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  childView,
  gfsRouteFailureMessage,
  listAccessiblePage,
  listChildrenPage,
  moveResourceReceipt,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilesPage } from '../FilesPage'

function ToastingFilesPage({ pendingGfsUri }: { pendingGfsUri: string }) {
  const toast = useToastController()
  return (
    <>
      <FilesPage
        pendingGfsUri={pendingGfsUri}
        onPendingGfsUriHandled={vi.fn()}
        pushToast={toast.pushToast}
      />
      <ToastStack items={toast.toasts} onDismiss={toast.dismissToast} />
    </>
  )
}

const member = (teamId: string, userId: string) => ({
  id: userId,
  email: `${userId}@example.test`,
  name: userId,
  picture: null,
  teamId,
  teamName: teamId,
  role: 'member' as const,
})

function authFor(teamId: string, userId = 'user-a'): AuthContextValue {
  return {
    booting: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    me: member(teamId, userId),
    email: `${userId}@example.test`,
    password: '',
    desktopSetupAuthorizationToken: '',
    desktopSetupStarted: false,
    desktopEnvironmentSetupComplete: true,
    runtimeConfigSetupName: '',
    runtimeConfigSetupExternalRestApiBaseUrl: '',
    runtimeConfigSetupRpcProxyBaseUrl: '',
    authTransitioning: false,
    runtimeConfigState: null,
    desktopReleaseStatus: null,
    pendingDesktopEnvironmentSetup: null,
    backendSwitchHint: null,
    runtimeConfigMissing: false,
    showRuntimeConfigSelector: false,
    dependencyHealth: null,
    hasDependencyOutage: false,
    setBooting: vi.fn(),
    setEmail: vi.fn(),
    setPassword: vi.fn(),
    setDesktopSetupAuthorizationToken: vi.fn(),
    setDesktopEnvironmentSetupComplete: vi.fn(),
    setPendingDesktopEnvironmentSetup: vi.fn(),
    setRuntimeConfigSetupName: vi.fn(),
    setRuntimeConfigSetupExternalRestApiBaseUrl: vi.fn(),
    setRuntimeConfigSetupRpcProxyBaseUrl: vi.fn(),
    setStatus: vi.fn(),
    loadSession: vi.fn(async () => undefined),
    handlePasswordLogin: vi.fn(async () => undefined),
    handleSwitchLoginBackend: vi.fn(async () => undefined),
    handleStartDesktopSetup: vi.fn(async () => undefined),
    handleCompleteDesktopSetup: vi.fn(async () => undefined),
    handleSaveRuntimeConfig: vi.fn(async () => null),
    handleDeleteRuntimeConfig: vi.fn(async () => undefined),
    handleSelectRuntimeConfig: vi.fn(async () => null),
    handleClearRuntimeConfigSelection: vi.fn(async () => null),
    handleCancelDesktopEnvironmentSetup: vi.fn(),
    handleConfirmDesktopEnvironmentSetup: vi.fn(async () => undefined),
    handleOpenDesktopRelease: vi.fn(async () => undefined),
    handleLogout: vi.fn(async () => undefined),
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FilesPage Move permission generation fencing', () => {
  it('retries Move authority without dispatching a Move (R4-L2)', async () => {
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('folder-src', 'Projects', 'directory', {
        parentResourceId: 'source-parent',
        path: '/Team/Projects',
        version: 7,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedDirectory('folder-src', 'Projects', {
        parentResourceId: 'source-parent',
        path: '/Team/Projects',
        version: 7,
      })
    )
    const resolvedArchive = await resolveResource(
      resolvedDirectory('destination-1', 'Archive', {
        parentResourceId: 'source-parent',
        path: '/Team/Archive',
        version: 4,
      })
    )
    const temporaryFailure = await affordancesApiError(
      500,
      { code: 'upstream_unavailable', message: 'permission service unavailable' },
      'source-parent'
    )
    let failNextSourceParentRead = false
    let sourceParentReads = 0
    let destinationReads = 0
    const produceAffordances = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === 'source-parent') {
        sourceParentReads += 1
        if (failNextSourceParentRead) {
          failNextSourceParentRead = false
          throw temporaryFailure
        }
        return heldPermissionResponse(['read', 'write', 'delete'])
      }
      if (resourceId === 'destination-1') {
        destinationReads += 1
        return heldPermissionResponse(['read', 'write', 'delete'])
      }
      return heldPermissionResponse(['read', 'write'])
    })
    const affordances = vi.fn((resourceId: string, drive?: string) =>
      produceAffordances(resourceId, drive)
    )
    const moveReceipt = await moveResourceReceipt('folder-src', 'destination-1', 8)
    const moveResource = vi.fn(async () => moveReceipt)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent')
              ? sourceParent
              : uri.endsWith('/foldersrc') || uri.endsWith('/folder-src')
                ? resolvedSource
                : resolvedArchive
          ),
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(
        <AuthContext.Provider value={authFor('team-a')}>
          <QueryClientProvider client={queryClient}>
            <ToastingFilesPage pendingGfsUri="gfs://main/source-parent" />
          </QueryClientProvider>
        </AuthContext.Provider>
      )

      fireEvent.click(await screen.findByRole('button', { name: 'Options for Projects' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move folder Projects' })
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
      const confirmMove = within(dialog).getByRole('button', { name: 'Move here (Archive)' })

      failNextSourceParentRead = true
      const readsBeforeFailure = sourceParentReads
      fireEvent.click(confirmMove)
      await waitFor(() => {
        expect(sourceParentReads).toBeGreaterThan(readsBeforeFailure)
        expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
      })
      expect(moveResource).not.toHaveBeenCalled()

      const readsBeforeRetry = sourceParentReads
      const destinationsBeforeRetry = destinationReads
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => {
        expect(
          within(dialog).queryByText('Permissions verified. Select Move to confirm.') ||
            moveResource.mock.calls.length > 0 ||
            !screen.queryByRole('dialog', { name: 'Move folder Projects' })
        ).toBeTruthy()
      })
      expect(sourceParentReads).toBeGreaterThan(readsBeforeRetry)
      expect(destinationReads).toBeGreaterThan(destinationsBeforeRetry)
      expect(moveResource).not.toHaveBeenCalled()
      expect(within(dialog).getByText('Permissions verified. Select Move to confirm.')).toBeTruthy()
    } finally {
      queryClient.clear()
    }
  })

  it.each([
    { dialog: 'closed' as const, outcome: 'success' as const },
    { dialog: 'closed' as const, outcome: 'failure' as const },
    { dialog: 'open' as const, outcome: 'success' as const },
    { dialog: 'open' as const, outcome: 'failure' as const },
  ])(
    'shows the $outcome Move outcome after navigating with the dialog $dialog',
    async ({ dialog: dialogState, outcome: outcomeKind }) => {
      const rows = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', {
          path: '/Archive',
          permissions: ['read', 'write'],
        }),
      ])
      const children = await listChildrenPage([
        childView('folder-src', 'Projects', 'directory', {
          parentResourceId: 'source-parent',
          path: '/Team/Projects',
          version: 7,
        }),
      ])
      const sourceParent = await resolveResource(
        resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
      )
      const resolvedSource = await resolveResource(
        resolvedDirectory('folder-src', 'Projects', {
          parentResourceId: 'source-parent',
          path: '/Team/Projects',
          version: 7,
        })
      )
      const resolvedArchive = await resolveResource(
        resolvedDirectory('destination-1', 'Archive', {
          parentResourceId: 'source-parent',
          path: '/Team/Archive',
          version: 4,
        })
      )
      let finishMove!: (value: { resourceId: string; version: number }) => void
      let rejectMove!: (error: Error) => void
      const moveGate = new Promise<{ resourceId: string; version: number }>((resolve, reject) => {
        finishMove = resolve
        rejectMove = reject
      })
      const produceAffordances = appServiceAffordanceProducer(async resourceId =>
        heldPermissionResponse(
          resourceId === 'source-parent'
            ? ['read', 'write', 'delete']
            : resourceId === 'destination-1'
              ? ['read', 'write', 'delete']
              : ['read']
        )
      )
      const affordances = vi.fn((resourceId: string, drive?: string) =>
        produceAffordances(resourceId, drive)
      )
      const moveResource = vi.fn(() => moveGate)
      const listChildren = vi.fn(async (resourceId: string) =>
        resourceId === 'source-parent' ? children : listChildrenPage([])
      )
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => rows),
            listChildren,
            affordances,
            resolve: vi.fn(async (uri: string) =>
              uri.endsWith('/source-parent')
                ? sourceParent
                : uri.endsWith('/foldersrc') || uri.endsWith('/folder-src')
                  ? resolvedSource
                  : resolvedArchive
            ),
            moveResource,
          },
        },
      })

      const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
      const renderPage = (pendingGfsUri: string) => (
        <AuthContext.Provider value={authFor('team-a')}>
          <QueryClientProvider client={queryClient}>
            <ToastingFilesPage pendingGfsUri={pendingGfsUri} />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
      const view = render(renderPage('gfs://main/source-parent'))

      fireEvent.click(await screen.findByRole('button', { name: 'Options for Projects' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move folder Projects' })
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Archive' }).at(-1)!)
      const moveButton = within(dialog).getByRole('button', { name: 'Move here (Archive)' })
      expect((moveButton as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(moveButton)
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('destination-1', 'main'))
      await waitFor(() =>
        expect(moveResource).toHaveBeenCalledWith(
          'folder-src',
          'destination-1',
          'main',
          7,
          undefined
        )
      )
      expect(moveResource).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('Moved Projects to Archive')).toBeNull()
      expect(
        screen.queryByText(
          'Moving a folder changes who can access its contents — access now follows the new location.'
        )
      ).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()

      if (dialogState === 'closed') {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
        expect(screen.queryByRole('dialog', { name: 'Move folder Projects' })).toBeNull()
      }
      view.rerender(renderPage('gfs://main/destination-1'))
      if (dialogState === 'open') {
        expect(screen.getByRole('dialog', { name: 'Move folder Projects' })).toBeTruthy()
      }
      await waitFor(() =>
        expect(listChildren.mock.calls.some(([resourceId]) => resourceId === 'destination-1')).toBe(
          true
        )
      )

      if (outcomeKind === 'success') {
        await act(async () => {
          finishMove({ resourceId: 'folder-src', version: 8 })
        })
        expect(await screen.findByText('Moved Projects to Archive')).toBeTruthy()
        expect(screen.getAllByText('Moved Projects to Archive')).toHaveLength(1)
        expect(
          screen.getAllByText(
            'Moving a folder changes who can access its contents — access now follows the new location.'
          )
        ).toHaveLength(1)
        const invalidatedKeys = invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey)
        const sourceChildrenKey = invalidatedKeys.find(
          key => key?.[3] === 'children' && key[5] === 'source-parent'
        )
        const destinationChildrenKey = invalidatedKeys.find(
          key => key?.[3] === 'children' && key[5] === 'destination-1'
        )
        const accessibleKey = invalidatedKeys.find(key => key?.[3] === 'accessible')
        expect(sourceChildrenKey).toBeTruthy()
        expect(destinationChildrenKey).toBeTruthy()
        expect(accessibleKey).toBeTruthy()
        expect(sourceChildrenKey?.[2]).toBe(destinationChildrenKey?.[2])
        expect(destinationChildrenKey?.[2]).toBe(accessibleKey?.[2])
      } else {
        await act(async () => {
          rejectMove(new Error('Move rejected httpStatus=400'))
        })
        const failureMessage =
          'Projects → Archive: The server rejected this destination. Refresh and choose a different folder.'
        expect(await screen.findByText(failureMessage)).toBeTruthy()
        expect(screen.getAllByText(failureMessage)).toHaveLength(1)
        expect(screen.queryByText('Moved Projects to Archive')).toBeNull()
        expect(
          screen.queryByText(
            'Moving a folder changes who can access its contents — access now follows the new location.'
          )
        ).toBeNull()
      }
      expect(moveResource).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves a newly selected destination when the captured Move returns 412 (R8-L4)', async () => {
    const staleVersionError = await gfsRouteFailureMessage(
      client =>
        client.moveResource(
          {
            resourceId: 'file-src',
            destinationId: 'destination-1',
            ifMatch: 3,
          },
          'fixture-session-token'
        ),
      412,
      { code: 'precondition_failed', message: 'the resource version changed' }
    )
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
      accessibleResource('destination-2', 'Backup', 'directory', {
        path: '/Backup',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('file-src', 'notes.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedFile('file-src', 'notes.txt', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      })
    )
    let rejectMove!: (error: Error) => void
    const moveGate = new Promise<{ resourceId: string; version: number }>((_resolve, reject) => {
      rejectMove = reject
    })
    const affordances = appServiceAffordanceProducer(async resourceId =>
      heldPermissionResponse(
        resourceId === 'source-parent' ? ['read', 'write', 'delete'] : ['read', 'write']
      )
    )
    const moveResource = vi.fn(() => moveGate)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent') ? sourceParent : resolvedSource
          ),
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <AuthContext.Provider value={authFor('team-a')}>
        <QueryClientProvider client={queryClient}>
          <ToastingFilesPage pendingGfsUri="gfs://main/source-parent" />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Options for notes.txt' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith('file-src', 'destination-1', 'main', 3, undefined)
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Backup' }))
    expect(within(dialog).getByText('Backup', { selector: 'strong' })).toBeTruthy()
    await act(async () => {
      rejectMove(new Error(staleVersionError))
    })

    const currentDialog = screen.getByRole('dialog', { name: 'Move file notes.txt' })
    expect(within(currentDialog).getByText('Backup', { selector: 'strong' })).toBeTruthy()
    expect(within(currentDialog).getByRole('button', { name: 'Move here (Backup)' })).toBeTruthy()
    const result = await screen.findByRole('alert')
    expect(
      within(result).getByText(
        'notes.txt → Archive: This item changed while you were moving it. Review its current location and try again.'
      )
    ).toBeTruthy()
    expect(moveResource).toHaveBeenCalledTimes(1)
  })

  it('keeps a captured Move result in its original team after a same-principal switch', async () => {
    const moveReceipt = await moveResourceReceipt('file-src', 'destination-1', 4)
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('file-src', 'notes.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedFile('file-src', 'notes.txt', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      })
    )
    let finishMove!: (value: { resourceId: string; version: number }) => void
    const moveGate = new Promise<{ resourceId: string; version: number }>(resolve => {
      finishMove = resolve
    })
    const affordances = appServiceAffordanceProducer(async resourceId =>
      heldPermissionResponse(
        resourceId === 'source-parent'
          ? ['read', 'write', 'delete']
          : resourceId === 'destination-1'
            ? ['read', 'write']
            : ['read']
      )
    )
    const moveResource = vi.fn(() => moveGate)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent') ? sourceParent : resolvedSource
          ),
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    const teamAScope = ':user-a:team-a'
    const teamBScope = ':user-a:team-b'
    const sourceChildrenA = desktopQueryKeys.gfsChildren(teamAScope, 'source-parent', 'main')
    const destinationChildrenA = desktopQueryKeys.gfsChildren(teamAScope, 'destination-1', 'main')
    const accessibleA = desktopQueryKeys.gfsAccessible(teamAScope, 'main')
    const sourceChildrenB = desktopQueryKeys.gfsChildren(teamBScope, 'source-parent', 'main')
    const destinationChildrenB = desktopQueryKeys.gfsChildren(teamBScope, 'destination-1', 'main')
    const accessibleB = desktopQueryKeys.gfsAccessible(teamBScope, 'main')
    const emptyChildren = await listChildrenPage([])
    queryClient.setQueryData(sourceChildrenA, { pages: [children], pageParams: [undefined] })
    queryClient.setQueryData(destinationChildrenA, {
      pages: [emptyChildren],
      pageParams: [undefined],
    })
    queryClient.setQueryData(accessibleA, { pages: [rows], pageParams: [undefined] })
    const renderPage = (teamId: string) => (
      <AuthContext.Provider value={authFor(teamId, 'user-a')}>
        <QueryClientProvider client={queryClient}>
          <ToastingFilesPage pendingGfsUri="gfs://main/source-parent" />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    const view = render(renderPage('team-a'))
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Options for notes.txt' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
      await waitFor(() =>
        expect(moveResource).toHaveBeenCalledWith('file-src', 'destination-1', 'main', 3, undefined)
      )

      view.rerender(renderPage('team-b'))
      await waitFor(() => expect(queryClient.getQueryData(sourceChildrenB)).toBeDefined())
      invalidateQueries.mockClear()
      await act(async () => finishMove(moveReceipt))
      await waitFor(() => expect(invalidateQueries).toHaveBeenCalled())

      expect(screen.queryByText('Moved notes.txt to Archive')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('dialog', { name: 'Move file notes.txt' })).toBeNull()
      const invalidatedKeys = invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey)
      expect(invalidatedKeys).toContainEqual(sourceChildrenA)
      expect(invalidatedKeys).toContainEqual(destinationChildrenA)
      expect(invalidatedKeys).toContainEqual(accessibleA)
      expect(invalidatedKeys).not.toContainEqual(sourceChildrenB)
      expect(invalidatedKeys).not.toContainEqual(destinationChildrenB)
      expect(invalidatedKeys).not.toContainEqual(accessibleB)
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => finishMove(moveReceipt))
      queryClient.clear()
    }
  })

  it('does not revoke the new team when an old Move returns a producer 401', async () => {
    const unauthorizedMessage = await gfsRouteFailureMessage(
      client =>
        client.moveResource(
          { resourceId: 'file-src', destinationId: 'destination-1', ifMatch: 3 },
          'fixture-session-token'
        ),
      401,
      { code: 'unauthorized', message: 'the captured session is no longer authorized' }
    )
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('file-src', 'notes.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedFile('file-src', 'notes.txt', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      })
    )
    let rejectMove!: (error: Error) => void
    const moveGate = new Promise<{ resourceId: string; version: number }>((_resolve, reject) => {
      rejectMove = reject
    })
    const affordances = appServiceAffordanceProducer(async resourceId =>
      heldPermissionResponse(
        resourceId === 'source-parent'
          ? ['read', 'write', 'delete']
          : resourceId === 'destination-1'
            ? ['read', 'write']
            : ['read']
      )
    )
    const moveResource = vi.fn(() => moveGate)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent') ? sourceParent : resolvedSource
          ),
          moveResource,
        },
      },
    })
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const renderPage = (teamId: string) => (
      <AuthContext.Provider value={authFor(teamId, 'user-a')}>
        <QueryClientProvider client={queryClient}>
          <ToastingFilesPage pendingGfsUri="gfs://main/source-parent" />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    const view = render(renderPage('team-a'))
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Options for notes.txt' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
      await waitFor(() =>
        expect(moveResource).toHaveBeenCalledWith('file-src', 'destination-1', 'main', 3, undefined)
      )

      view.rerender(renderPage('team-b'))
      await act(async () => rejectMove(new Error(unauthorizedMessage)))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      expect(screen.queryByText('File access is not authorized')).toBeNull()
      expect(
        screen.queryByText('Your current Desktop session cannot access this location.')
      ).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => rejectMove(new Error(unauthorizedMessage)))
      queryClient.clear()
    }
  })

  it('reports a completed folder Move after its dialog closes in flight', async () => {
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('folder-src', 'Projects', 'directory', {
        parentResourceId: 'source-parent',
        path: '/Team/Projects',
        version: 7,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedDirectory('folder-src', 'Projects', {
        parentResourceId: 'source-parent',
        path: '/Team/Projects',
        version: 7,
      })
    )
    let finishMove!: (value: { resourceId: string; version: number }) => void
    const moveGate = new Promise<{ resourceId: string; version: number }>(resolve => {
      finishMove = resolve
    })
    const affordances = appServiceAffordanceProducer(async resourceId =>
      heldPermissionResponse(
        resourceId === 'source-parent'
          ? ['read', 'write', 'delete']
          : resourceId === 'destination-1'
            ? ['read', 'write']
            : ['read']
      )
    )
    const moveResource = vi.fn(() => moveGate)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent') ? sourceParent : resolvedSource
          ),
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <AuthContext.Provider value={authFor('team-a')}>
        <QueryClientProvider client={queryClient}>
          <FilesPage
            pendingGfsUri="gfs://main/source-parent"
            onPendingGfsUriHandled={vi.fn()}
            pushToast={pushToast}
          />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Options for Projects' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move folder Projects' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith('folder-src', 'destination-1', 'main', 7, undefined)
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
    expect(screen.queryByRole('dialog', { name: 'Move folder Projects' })).toBeNull()
    expect(pushToast).not.toHaveBeenCalled()

    await act(async () => {
      finishMove({ resourceId: 'folder-src', version: 8 })
    })

    expect(pushToast).toHaveBeenCalledWith('Moved Projects to Archive', 'success')
    expect(pushToast).toHaveBeenCalledWith(
      'Moving a folder changes who can access its contents — access now follows the new location.',
      'info'
    )
  })

  it('reports a failed Move after its dialog closes in flight', async () => {
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('file-src', 'notes.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedFile('file-src', 'notes.txt', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      })
    )
    let rejectMove!: (error: Error) => void
    const moveGate = new Promise<{ resourceId: string; version: number }>((_resolve, reject) => {
      rejectMove = reject
    })
    const affordances = appServiceAffordanceProducer(async resourceId =>
      heldPermissionResponse(
        resourceId === 'source-parent'
          ? ['read', 'write', 'delete']
          : resourceId === 'destination-1'
            ? ['read', 'write']
            : ['read']
      )
    )
    const moveResource = vi.fn(() => moveGate)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent') ? sourceParent : resolvedSource
          ),
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <AuthContext.Provider value={authFor('team-a')}>
        <QueryClientProvider client={queryClient}>
          <FilesPage
            pendingGfsUri="gfs://main/source-parent"
            onPendingGfsUriHandled={vi.fn()}
            pushToast={pushToast}
          />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Options for notes.txt' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith('file-src', 'destination-1', 'main', 3, undefined)
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
    expect(screen.queryByRole('dialog', { name: 'Move file notes.txt' })).toBeNull()

    await act(async () => {
      rejectMove(new Error('Move rejected httpStatus=400'))
    })

    expect(pushToast).toHaveBeenCalledWith(
      'notes.txt → Archive: The server rejected this destination. Refresh and choose a different folder.',
      'error'
    )
  })

  it('reports a dispatched name conflict when closing cancels the numbered retry', async () => {
    const conflictMessage = await gfsRouteFailureMessage(
      client =>
        client.moveResource(
          {
            resourceId: 'file-src',
            destinationId: 'destination-1',
            ifMatch: 3,
          },
          'fixture-session-token'
        ),
      409,
      { code: 'name_conflict', message: 'an item with this name already exists' }
    )
    const rows = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    const children = await listChildrenPage([
      childView('file-src', 'notes.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      }),
    ])
    const sourceParent = await resolveResource(
      resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
    )
    const resolvedSource = await resolveResource(
      resolvedFile('file-src', 'notes.txt', {
        parentResourceId: 'source-parent',
        path: '/Team/notes.txt',
        version: 3,
      })
    )
    const resolvedArchive = await resolveResource(
      resolvedDirectory('destination-1', 'Archive', {
        parentResourceId: 'source-parent',
        path: '/Team/Archive',
        version: 4,
      })
    )
    let rejectMove!: (error: Error) => void
    const moveGate = new Promise<{ resourceId: string; version: number }>((_resolve, reject) => {
      rejectMove = reject
    })
    const affordances = appServiceAffordanceProducer(async resourceId =>
      heldPermissionResponse(
        resourceId === 'source-parent'
          ? ['read', 'write', 'delete']
          : resourceId === 'destination-1' || resourceId === 'file-src'
            ? ['read', 'write']
            : ['read']
      )
    )
    const moveResource = vi.fn(() => moveGate)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'source-parent' ? children : listChildrenPage([])
          ),
          affordances,
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith('/source-parent')
              ? sourceParent
              : uri.endsWith('/filesrc') || uri.endsWith('/file-src')
                ? resolvedSource
                : resolvedArchive
          ),
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <AuthContext.Provider value={authFor('team-a')}>
        <QueryClientProvider client={queryClient}>
          <ToastingFilesPage pendingGfsUri="gfs://main/source-parent" />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Options for notes.txt' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith('file-src', 'destination-1', 'main', 3, undefined)
    )
    expect(moveResource).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
    expect(screen.queryByRole('dialog', { name: 'Move file notes.txt' })).toBeNull()

    await act(async () => rejectMove(new Error(conflictMessage)))

    expect(
      await screen.findByText(
        'notes.txt → Archive: An item with this name already exists. Choose another folder, or use Move to change its name if you have rename access.'
      )
    ).toBeTruthy()
    expect(moveResource).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Move file notes.txt' })).toBeNull()
  })

  it('does not move a selected file after its team scope changes during confirmation', async () => {
    const rows = await listAccessiblePage([
      accessibleResource('file-1', 'report.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/report.txt',
        permissions: ['read'],
      }),
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    let finishDestinationCheck!: (value: {
      held: string[]
      canDelegate: boolean
      grantableBits: string[]
      canCreateShare: boolean
    }) => void
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'destination-1') {
        return new Promise<{
          held: string[]
          canDelegate: boolean
          grantableBits: string[]
          canCreateShare: boolean
        }>(resolve => {
          finishDestinationCheck = resolve
        })
      }
      return {
        held: ['read', 'write', 'delete'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      }
    })
    const moveResource = vi.fn(async () => undefined)
    const listAccessible = vi.fn(async () => rows)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const renderPage = (teamId: string, userId = 'user-a') => (
      <AuthContext.Provider value={authFor(teamId, userId)}>
        <QueryClientProvider client={queryClient}>
          <FilesPage />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    const view = render(renderPage('team-a'))

    const row = await screen.findByRole('button', { name: 'Options for report.txt' })
    fireEvent.click(row)
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))

    const dialog = await screen.findByRole('dialog', { name: 'Move file report.txt' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('destination-1', 'main'))
    expect(within(dialog).getByText('Checking permissions…')).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()

    view.rerender(renderPage('team-b', 'user-b'))
    await act(async () => {
      finishDestinationCheck({
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      })
    })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move file report.txt' })).toBeNull()
    )
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('does not confirm a retry for a destination replaced while fresh permissions are pending', async () => {
    const rows = await listAccessiblePage([
      accessibleResource('file-1', 'report.txt', 'file', {
        parentResourceId: 'source-parent',
        path: '/Team/report.txt',
        permissions: ['read'],
      }),
      accessibleResource('destination-a', 'Archive A', 'directory', {
        path: '/Archive A',
        permissions: ['read', 'write'],
      }),
      accessibleResource('destination-b', 'Archive B', 'directory', {
        path: '/Archive B',
        permissions: ['read', 'write'],
      }),
    ])
    let sourceCalls = 0
    let finishRetrySource!: () => void
    let markRetryStarted!: () => void
    const retryStarted = new Promise<void>(resolve => {
      markRetryStarted = resolve
    })
    const retryGate = new Promise<void>(resolve => {
      finishRetrySource = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === 'source-parent') {
        sourceCalls += 1
        if (sourceCalls === 2) return heldPermissionResponse(['read', 'delete'])
        if (sourceCalls === 3) {
          markRetryStarted()
          await retryGate
        }
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const affordances = vi.fn((resourceId: string, drive?: string) =>
      produceAffordances(resourceId, drive)
    )
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => rows),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
          moveResource,
        },
      },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <AuthContext.Provider value={authFor('team-a')}>
        <QueryClientProvider client={queryClient}>
          <FilesPage />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Options for report.txt' }))
    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Move to' })).toBeTruthy())
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file report.txt' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive A' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive A)' }))
    expect(
      await within(dialog).findByText(
        'You do not have write and delete access to the source folder.'
      )
    ).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
    await retryStarted
    expect(within(dialog).queryByRole('button', { name: 'Retry permission check' })).toBeNull()
    expect(
      (within(dialog).getByRole('button', { name: 'Move here (Archive A)' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive B' }))
    await act(async () => {
      finishRetrySource()
    })

    expect(
      await within(dialog).findByRole('button', { name: 'Move here (Archive B)' })
    ).toBeTruthy()
    expect(within(dialog).queryByText('Checking permissions…')).toBeNull()
    expect(within(dialog).queryByText('Permissions verified. Select Move to confirm.')).toBeNull()
    expect(moveResource).not.toHaveBeenCalled()
    expect(affordances).toHaveBeenCalledWith('source-parent', 'main')
    expect(affordances).toHaveBeenCalledWith('destination-a', 'main')
  })

  it.each([
    {
      kind: 'file' as const,
      sourceId: 'file-src',
      sourceName: 'notes.txt',
      transition: 'page unmount' as const,
    },
    {
      kind: 'directory' as const,
      sourceId: 'folder-src',
      sourceName: 'Projects',
      transition: 'page unmount' as const,
    },
    {
      kind: 'file' as const,
      sourceId: 'file-src',
      sourceName: 'notes.txt',
      transition: 'team switch' as const,
    },
    {
      kind: 'directory' as const,
      sourceId: 'folder-src',
      sourceName: 'Projects',
      transition: 'team switch' as const,
    },
  ])(
    'suppresses a dispatched $kind drag outcome after $transition and converges its captured cache',
    async ({ kind, sourceId, sourceName, transition }) => {
      const destinationId = 'destination-1'
      const destinationName = 'Archive'
      const sourceVersion = 3
      const rows = await listAccessiblePage([
        accessibleResource(destinationId, destinationName, 'directory', {
          path: '/Archive',
          permissions: ['read', 'write'],
        }),
      ])
      const children = await listChildrenPage([
        childView(sourceId, sourceName, kind, {
          parentResourceId: 'source-parent',
          path: `/Team/${sourceName}`,
          version: sourceVersion,
        }),
        childView(destinationId, destinationName, 'directory', {
          parentResourceId: 'source-parent',
          path: '/Team/Archive',
          version: 4,
        }),
      ])
      const sourceParent = await resolveResource(
        resolvedDirectory('source-parent', 'Team', { gfsUri: 'gfs://main/source-parent' })
      )
      const resolvedSource = await resolveResource(
        kind === 'file'
          ? resolvedFile(sourceId, sourceName, {
              parentResourceId: 'source-parent',
              path: `/Team/${sourceName}`,
              version: sourceVersion,
            })
          : resolvedDirectory(sourceId, sourceName, {
              parentResourceId: 'source-parent',
              path: `/Team/${sourceName}`,
              version: sourceVersion,
            })
      )
      const resolvedDestination = await resolveResource(
        resolvedDirectory(destinationId, destinationName, {
          parentResourceId: 'source-parent',
          path: '/Team/Archive',
          version: 4,
        })
      )
      const moveReceipt = await moveResourceReceipt(sourceId, destinationId, sourceVersion + 1)
      let finishMove!: (receipt: typeof moveReceipt) => void
      const moveGate = new Promise<typeof moveReceipt>(resolve => {
        finishMove = resolve
      })
      const produceAffordances = appServiceAffordanceProducer(async resourceId =>
        heldPermissionResponse(
          resourceId === 'source-parent' || resourceId === destinationId
            ? ['read', 'write', 'delete']
            : ['read', 'write']
        )
      )
      const affordances = vi.fn((resourceId: string, drive?: string) =>
        produceAffordances(resourceId, drive)
      )
      const moveResource = vi.fn(() => moveGate)
      const pushToast = vi.fn()
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => rows),
            listChildren: vi.fn(async (resourceId: string) =>
              resourceId === 'source-parent' ? children : listChildrenPage([])
            ),
            affordances,
            resolve: vi.fn(async (uri: string) =>
              uri.endsWith('/source-parent')
                ? sourceParent
                : uri.endsWith(`/${sourceId}`)
                  ? resolvedSource
                  : resolvedDestination
            ),
            moveResource,
          },
        },
      })

      const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
      const scope = ':user-a:team-a'
      const newTeamScope = ':user-a:team-b'
      const sourceChildrenKey = desktopQueryKeys.gfsChildren(scope, 'source-parent', 'main')
      const destinationChildrenKey = desktopQueryKeys.gfsChildren(scope, destinationId, 'main')
      const accessibleKey = desktopQueryKeys.gfsAccessible(scope, 'main')
      const newTeamSourceChildrenKey = desktopQueryKeys.gfsChildren(
        newTeamScope,
        'source-parent',
        'main'
      )
      const newTeamDestinationChildrenKey = desktopQueryKeys.gfsChildren(
        newTeamScope,
        destinationId,
        'main'
      )
      const newTeamAccessibleKey = desktopQueryKeys.gfsAccessible(newTeamScope, 'main')
      queryClient.setQueryData(sourceChildrenKey, { pages: [children], pageParams: [undefined] })
      queryClient.setQueryData(destinationChildrenKey, {
        pages: [await listChildrenPage([])],
        pageParams: [undefined],
      })
      queryClient.setQueryData(accessibleKey, { pages: [rows], pageParams: [undefined] })
      queryClient.setQueryData(newTeamSourceChildrenKey, {
        pages: [children],
        pageParams: [undefined],
      })
      queryClient.setQueryData(newTeamDestinationChildrenKey, {
        pages: [await listChildrenPage([])],
        pageParams: [undefined],
      })
      queryClient.setQueryData(newTeamAccessibleKey, { pages: [rows], pageParams: [undefined] })

      const renderPage = (teamId: string) => (
        <AuthContext.Provider value={authFor(teamId)}>
          <QueryClientProvider client={queryClient}>
            <FilesPage
              pendingGfsUri="gfs://main/source-parent"
              onPendingGfsUriHandled={vi.fn()}
              pushToast={pushToast}
            />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
      const view = render(renderPage('team-a'))
      try {
        const sourceRow = await screen.findByRole('button', { name: `Open ${sourceName}` })
        const destinationRow = screen.getByRole('button', { name: `Open ${destinationName}` })
        const dataTransfer = {
          types: ['application/x-evenfire-gfs-resource'],
          files: [],
          effectAllowed: 'none',
          dropEffect: 'none',
          setData: vi.fn(),
        }
        fireEvent.dragStart(sourceRow, { dataTransfer })
        fireEvent.dragEnter(destinationRow, { dataTransfer })
        await waitFor(() => expect(affordances).toHaveBeenCalledWith(destinationId, 'main'))
        fireEvent.dragOver(destinationRow, { dataTransfer })
        fireEvent.drop(destinationRow, { dataTransfer })

        if (kind === 'directory') {
          const dialog = await screen.findByRole('dialog', {
            name: `Move folder ${sourceName} to ${destinationName}`,
          })
          await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
          })
        }

        await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(1))
        expect(moveResource).toHaveBeenCalledWith(
          sourceId,
          destinationId,
          'main',
          sourceVersion,
          undefined
        )
        expect(pushToast).not.toHaveBeenCalled()
        invalidateQueries.mockClear()

        if (transition === 'page unmount') {
          view.unmount()
        } else {
          view.rerender(renderPage('team-b'))
        }
        await act(async () => finishMove(moveReceipt))

        expect(pushToast).not.toHaveBeenCalled()
        const invalidatedKeys = invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey)
        expect(invalidatedKeys).toContainEqual(sourceChildrenKey)
        expect(invalidatedKeys).toContainEqual(destinationChildrenKey)
        expect(invalidatedKeys).toContainEqual(accessibleKey)
        expect(invalidatedKeys).not.toContainEqual(newTeamSourceChildrenKey)
        expect(invalidatedKeys).not.toContainEqual(newTeamDestinationChildrenKey)
        expect(invalidatedKeys).not.toContainEqual(newTeamAccessibleKey)
        expect(moveResource).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => finishMove(moveReceipt))
        queryClient.clear()
      }
    }
  )
})
