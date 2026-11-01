// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { GFS_AUTHORITY_STALE_TIME_MS } from '@lib/gfsAuthorityQueryPolicy'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
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

function authFor(teamId: string): AuthContextValue {
  return {
    booting: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    sessionGeneration: 1,
    me: member(teamId, 'user-a'),
    email: 'user-a@example.test',
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

type AffordancesProducer = (
  resourceId: string,
  drive: string
) => Promise<ReturnType<typeof delegationAffordances>>

async function renderCurrentFileReplaceScenario(
  produceAffordances: AffordancesProducer = async () =>
    delegationAffordances(new Set(['read', 'write', 'manage_acl']), false)
) {
  const fileId = '0123456789abcdef0123456789abcdef'
  const fileUri = `gfs://main/${fileId}`
  const row = accessibleResource(fileId, 'report.txt', 'file', {
    gfsUri: fileUri,
    parentResourceId: 'parent-1',
    version: 7,
    permissions: ['read', 'write', 'manage_acl'],
  })
  const file = await resolveResource(
    resolvedFile(fileId, 'report.txt', {
      gfsUri: fileUri,
      parentResourceId: 'parent-1',
      version: 7,
    })
  )
  const affordances = vi.fn(produceAffordances)
  const replaceFileFromPath = vi.fn(async () => undefined)
  const getPathForFile = vi.fn(() => '/fixture/report.txt')
  const listAccessible = vi.fn(async () => listAccessiblePage([row]))
  const resolve = vi.fn(async (uri: string) => {
    if (uri === fileUri) return file
    throw new Error(`unexpected resource URI: ${uri}`)
  })
  const pushToast = vi.fn()
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: {
        listAccessible,
        listChildren: vi.fn(async () => listChildrenPage([])),
        resolve,
        affordances,
        listGrants: vi.fn(async () => []),
        listShares: vi.fn(async () => []),
        listInheritedAccess: vi.fn(async () => []),
        replaceFileFromPath,
        getPathForFile,
      },
    },
  })

  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const user = userEvent.setup()
  const view = render(
    <AuthContext.Provider value={authFor('team-a')}>
      <QueryClientProvider client={client}>
        <FilesPage pushToast={pushToast} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )

  await openManageForRow(user, 'report.txt')
  await waitFor(() => expect(affordances).toHaveBeenCalledWith(fileId, 'main'))
  expect(await screen.findByRole('dialog', { name: 'Share file report.txt' })).toBeTruthy()
  const key = desktopQueryKeys.gfsAffordances(':user-a:team-a', fileId, 'main', 1)
  await waitFor(() => expect(client.getQueryData(key)).toBeDefined())

  return {
    affordances,
    client,
    fileId,
    key,
    pushToast,
    replaceFileFromPath,
    user,
    view,
  }
}

async function selectReplacement(replaceMenuItem: HTMLElement) {
  const replaceInput = screen.getByLabelText('Replace report.txt') as HTMLInputElement
  await act(async () => {
    fireEvent.click(replaceMenuItem)
    fireEvent.change(replaceInput, {
      target: { files: [new File(['new contents'], 'report.txt', { type: 'text/plain' })] },
    })
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

async function openManageForRow(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Share ${name}` }))
}

async function reachCurrentFileReplaceThroughKeyboard(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole('dialog', { name: 'Share file report.txt' })
  const options = screen.getByRole('button', { name: 'Options for report.txt' })
  const close = within(dialog).getByRole('button', { name: 'Close share dialog' })
  expect(document.activeElement).toBe(close)

  for (let index = 0; index < 40 && document.activeElement !== options; index += 1) {
    await user.tab({ shift: true })
  }
  expect(document.activeElement).toBe(options)
  await user.keyboard('{Enter}')
  const menu = within(screen.getByRole('menu', { name: 'Actions for report.txt' }))
  const replace = menu.getByRole('menuitem', { name: 'Replace file' })
  return replace
}

describe('FilesPage current-file Replace permission freshness', () => {
  it('rechecks expired write authority after the Manage-to-Replace keyboard route', async () => {
    let revoked = false
    const scenario = await renderCurrentFileReplaceScenario(async () => {
      return delegationAffordances(
        new Set(revoked ? ['read', 'manage_acl'] : ['read', 'write', 'manage_acl']),
        false
      )
    })
    const readsBeforeExpiry = scenario.affordances.mock.calls.length
    expect(readsBeforeExpiry).toBeGreaterThan(0)
    const replaceMenuItem = await reachCurrentFileReplaceThroughKeyboard(scenario.user)

    revoked = true
    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GFS_AUTHORITY_STALE_TIME_MS + 1)
    })
    expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry)
    expect(replaceMenuItem.isConnected).toBe(true)

    await selectReplacement(replaceMenuItem)

    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()
    expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry + 1)
    expect(scenario.affordances).toHaveBeenLastCalledWith(scenario.fileId, 'main')
    expect(scenario.pushToast).toHaveBeenCalledWith(
      'You do not have write access to report.txt.',
      'error'
    )
    scenario.client.clear()
  })

  it('cancels a deferred positive refresh after the authenticated team changes', async () => {
    const allowed = delegationAffordances(new Set(['read', 'write', 'manage_acl']), false)
    let resolveRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    const refresh = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      resolveRefresh = resolve
    })
    const scenario = await renderCurrentFileReplaceScenario(async () => allowed)
    const readsBeforeExpiry = scenario.affordances.mock.calls.length
    await reachCurrentFileReplaceThroughKeyboard(scenario.user)

    vi.useFakeTimers({ toFake: ['Date'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GFS_AUTHORITY_STALE_TIME_MS + 1)
    })
    scenario.affordances.mockImplementationOnce(async () => refresh)
    const replaceMenuItem = screen.getByRole('menuitem', { name: 'Replace file' })
    await selectReplacement(replaceMenuItem)
    await waitFor(() => expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry + 1))
    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()
    expect(scenario.pushToast).toHaveBeenCalledWith(
      'Checking write permission for report.txt…',
      'info'
    )

    scenario.view.rerender(
      <AuthContext.Provider value={authFor('team-b')}>
        <QueryClientProvider client={scenario.client}>
          <FilesPage pushToast={scenario.pushToast} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    await act(async () => resolveRefresh(allowed))
    await waitFor(() =>
      expect(scenario.pushToast).toHaveBeenCalledWith(
        'Replace was not started for report.txt because the workspace changed.',
        'error'
      )
    )
    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()
    scenario.client.clear()
  })

  it('cancels a deferred positive refresh after explicit navigation leaves the target', async () => {
    const allowed = delegationAffordances(new Set(['read', 'write', 'manage_acl']), false)
    let resolveRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    const refresh = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      resolveRefresh = resolve
    })
    const scenario = await renderCurrentFileReplaceScenario(async () => allowed)
    const readsBeforeExpiry = scenario.affordances.mock.calls.length
    await reachCurrentFileReplaceThroughKeyboard(scenario.user)

    vi.useFakeTimers({ toFake: ['Date'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GFS_AUTHORITY_STALE_TIME_MS + 1)
    })
    scenario.affordances.mockImplementationOnce(async () => refresh)
    await selectReplacement(screen.getByRole('menuitem', { name: 'Replace file' }))
    await waitFor(() => expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry + 1))
    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()

    await scenario.user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await scenario.user.click(screen.getByRole('button', { name: 'Shared with me' }))
    expect(
      (screen.getByRole('button', { name: 'Shared with me' }) as HTMLButtonElement).disabled
    ).toBe(true)

    await act(async () => resolveRefresh(allowed))
    await waitFor(() =>
      expect(scenario.pushToast).toHaveBeenCalledWith(
        'Replace was not started for report.txt because the workspace changed.',
        'error'
      )
    )
    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()
    scenario.client.clear()
  })

  it('surfaces Retry-After, suppresses an early network retry, and rechecks before Replace', async () => {
    let retryAt = 0
    const allowed = delegationAffordances(new Set(['read', 'write', 'manage_acl']), false)
    const scenario = await renderCurrentFileReplaceScenario(async () => {
      if (retryAt && Date.now() < retryAt) {
        throw new Error(
          "Error invoking remote method 'gfs:affordances': 429 Too Many Requests " +
            'httpStatus=429 retryAfterSeconds=7'
        )
      }
      return allowed
    })
    const readsBeforeExpiry = scenario.affordances.mock.calls.length
    await reachCurrentFileReplaceThroughKeyboard(scenario.user)

    vi.useFakeTimers({ toFake: ['Date'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GFS_AUTHORITY_STALE_TIME_MS + 1)
    })
    retryAt = Date.now() + 7_000
    const firstRetryMenuItem = screen.getByRole('menuitem', { name: 'Replace file' })
    await selectReplacement(firstRetryMenuItem)
    await waitFor(() => expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry + 1))
    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()
    expect(scenario.pushToast).toHaveBeenCalledWith(
      'Too many file requests — try again in 7s.',
      'error'
    )

    const options = screen.getByRole('button', { name: 'Options for report.txt' })
    fireEvent.click(options)
    const retryMenuItem = within(
      screen.getByRole('menu', { name: 'Actions for report.txt' })
    ).getByRole('menuitem', { name: 'Replace file' })
    await selectReplacement(retryMenuItem)
    expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry + 1)
    expect(scenario.replaceFileFromPath).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001)
    })
    const finalOptions = screen.getByRole('button', { name: 'Options for report.txt' })
    fireEvent.click(finalOptions)
    const finalMenuItem = within(
      screen.getByRole('menu', { name: 'Actions for report.txt' })
    ).getByRole('menuitem', { name: 'Replace file' })
    await selectReplacement(finalMenuItem)
    await waitFor(() => expect(scenario.replaceFileFromPath).toHaveBeenCalledOnce())
    expect(scenario.affordances).toHaveBeenCalledTimes(readsBeforeExpiry + 2)
    expect(scenario.replaceFileFromPath).toHaveBeenCalledWith(
      scenario.fileId,
      '/fixture/report.txt',
      'main',
      7
    )
    scenario.client.clear()
  })
})
