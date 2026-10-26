// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilesPage } from '../FilesPage'

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
})
