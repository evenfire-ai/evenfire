// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilesPage } from '../FilesPage'

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
  me,
  runtimeConfigState: { envKey: 'test-environment' },
} as unknown as AuthContextValue

function wrapper(client: QueryClient) {
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
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
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
    expect(screen.getByText('Permissions will be checked when you use an action.')).toBeTruthy()
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
    expect(screen.getByText('Checking permissions for report.txt…')).toBeTruthy()
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
          'main'
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
})
