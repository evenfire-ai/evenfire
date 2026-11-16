// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getPermissionErrorsForOwner } from '@components/Common/permissionErrorAcknowledgement'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
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
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilesPage } from '../FilesPage'

const hookTrace = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@hooks/domain/useGfsBrowserController', async importOriginal => {
  const original = await importOriginal<typeof import('@hooks/domain/useGfsBrowserController')>()
  return {
    ...original,
    useGfsBrowserController: (options?: unknown) => {
      const state = original.useGfsBrowserController(options as never)
      hookTrace.calls.push(state as unknown as Record<string, unknown>)
      return state
    },
  }
})
vi.mock('electron', () => ({
  app: { getPath: () => '/evenfire-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

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
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
  }
}

function Composite({ showTree }: { showTree: boolean }) {
  return (
    <>
      <FilesPage pendingGfsUri="gfs://main/raw-membership" />
      {showTree && (
        <FileExplorerTree onOpenFolder={() => {}} onOpenPreview={() => {}} pushToast={() => {}} />
      )}
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
  hookTrace.calls.length = 0
})

describe('Files permission membership after a Sidebar raw write', () => {
  it('keeps the visible Files permission error through an unmarked same-Query omission', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-probe', 'Reports', { gfsUri: 'gfs://main/raw-membership' })
    )
    const row = childView('row-probe', 'report.txt', 'file', {
      parentResourceId: 'folder-probe',
    })
    const initial = await listChildrenPage([row])
    const rawOmission = await listChildrenPage([])
    let childReads = 0
    const listChildren = vi.fn(async () => (++childReads === 1 ? initial : rawOmission))
    const permissions = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'row-probe')
        return Promise.reject(new Error('503 permission service unavailable'))
      return Promise.resolve(heldPermissionResponse(['read']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () =>
            listAccessiblePage([accessibleResource('folder-probe', 'Reports', 'directory')])
          ),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => permissions(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const key = desktopQueryKeys.gfsChildren(
      'test-environment:user-1:team-1',
      'folder-probe',
      'main',
      0
    )
    let rerender: (ui: ReactNode) => void = () => {}
    let unmount: () => void = () => {}
    try {
      const view = render(<Composite showTree={false} />, { wrapper: wrapper(client) })
      rerender = view.rerender
      unmount = view.unmount
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await screen.findByRole('alertdialog')
      const query = client.getQueryCache().find({ exact: true, queryKey: key })
      const before = hookTrace.calls.at(-1) as {
        permissionBindingChildResourceIds: string[]
        permissionBindingComplete: boolean
      }
      expect(before.permissionBindingChildResourceIds).toContain('row-probe')
      expect(before.permissionBindingComplete).toBe(true)
      expect(getPermissionErrorsForOwner('files').errors).toHaveLength(1)

      rerender(<Composite showTree />)
      fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: key })
      })
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))

      const filesController = hookTrace.calls
        .slice()
        .reverse()
        .find(
          call =>
            (call as { permissionBindingComplete?: boolean }).permissionBindingComplete === false
        ) as {
        permissionBindingChildResourceIds: string[]
        permissionBindingComplete: boolean
      }
      expect(screen.getByRole('alertdialog').textContent).toContain(
        'Could not verify permissions for report.txt'
      )
      expect(childReads).toBe(2)
      expect(client.getQueryCache().find({ exact: true, queryKey: key })).toBe(query)
      expect(
        client.getQueryData<{ pages: Array<{ items: unknown[] }> }>(key)?.pages[0]?.items
      ).toEqual([])
      expect(filesController.permissionBindingChildResourceIds).toContain('row-probe')
      expect(filesController.permissionBindingComplete).toBe(false)
      expect(getPermissionErrorsForOwner('files').errors).toHaveLength(1)
    } finally {
      unmount()
      client.clear()
    }
  })

  it('does not transfer membership from a removed listing Query to its replacement', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-replaced', 'Reports', { gfsUri: 'gfs://main/replaced-listing' })
    )
    const otherFolder = await resolveResource(
      resolvedDirectory('folder-other', 'Projects', { gfsUri: 'gfs://main/other-listing' })
    )
    const row = childView('row-replaced', 'old-report.txt', 'file', {
      parentResourceId: 'folder-replaced',
    })
    const nestedFolder = childView('folder-other', 'Projects', 'directory', {
      parentResourceId: 'folder-replaced',
      gfsUri: 'gfs://main/other-listing',
    })
    const completeListing = await listChildrenPage([row, nestedFolder])
    const rawOmission = await listChildrenPage([])
    let folderReads = 0
    let releaseReplacement!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    const replacementPending = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(
      resolve => {
        releaseReplacement = resolve
      }
    )
    const listChildren = vi.fn(async (parentResourceId: string) => {
      if (parentResourceId === 'folder-other') return listChildrenPage([])
      folderReads += 1
      return folderReads === 1 ? completeListing : replacementPending
    })
    const permissions = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'row-replaced')
        return Promise.reject(new Error('403 Forbidden: resource_access_denied httpStatus=403'))
      return Promise.resolve(heldPermissionResponse(['read']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () =>
            listAccessiblePage([accessibleResource('folder-replaced', 'Reports', 'directory')])
          ),
          resolve: vi.fn(async (uri: string) =>
            uri === 'gfs://main/other-listing' ? otherFolder : folder
          ),
          listChildren,
          affordances: vi.fn((resourceId: string) => permissions(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowPermissionKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'row-replaced',
      'main',
      0
    )
    const key = desktopQueryKeys.gfsChildren(
      'test-environment:user-1:team-1',
      'folder-replaced',
      'main',
      0
    )
    let unmount: () => void = () => {}
    try {
      const view = render(<FilesPage pendingGfsUri="gfs://main/replaced-listing" />, {
        wrapper: wrapper(client),
      })
      unmount = view.unmount
      await screen.findByRole('button', { name: 'Options for old-report.txt' })
      await screen.findByRole('alertdialog')
      const previousQuery = client.getQueryCache().find({ exact: true, queryKey: key })
      expect(previousQuery).toBeDefined()

      fireEvent.click(await screen.findByRole('button', { name: 'Projects' }))
      await waitFor(() =>
        expect(listChildren).toHaveBeenCalledWith('folder-other', 'main', undefined)
      )
      await screen.findByText('This folder is empty')
      await act(async () => {
        client.removeQueries({ exact: true, queryKey: key })
      })
      expect(client.getQueryCache().find({ exact: true, queryKey: key })).toBeUndefined()
      const breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
      fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Reports' }))
      await waitFor(() => expect(folderReads).toBe(2))
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('fetching'))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowPermissionKey, type: 'all' })
      })
      await waitFor(() => expect(client.getQueryState(rowPermissionKey)?.status).toBe('error'))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(client.getQueryCache().find({ exact: true, queryKey: key })).not.toBe(previousQuery)
      expect(folderReads).toBe(2)
      const replacementProjection = hookTrace.calls.at(-1) as {
        permissionBindingChildResourceIds: string[]
      }
      expect(replacementProjection.permissionBindingChildResourceIds).not.toContain('row-replaced')
      expect(getPermissionErrorsForOwner('files').errors).toHaveLength(0)
    } finally {
      releaseReplacement(rawOmission)
      unmount()
      client.clear()
    }
  })

  it('retires the permission error after a complete current Files listing omits the child', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-complete', 'Reports', { gfsUri: 'gfs://main/complete-listing' })
    )
    const row = childView('row-complete', 'old-report.txt', 'file', {
      parentResourceId: 'folder-complete',
    })
    const initial = await listChildrenPage([row])
    const completeOmission = await listChildrenPage([])
    let childReads = 0
    const listChildren = vi.fn(async () => (++childReads === 1 ? initial : completeOmission))
    const permissions = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'row-complete')
        return Promise.reject(new Error('503 permission service unavailable'))
      return Promise.resolve(heldPermissionResponse(['read']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () =>
            listAccessiblePage([accessibleResource('folder-complete', 'Reports', 'directory')])
          ),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => permissions(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const key = desktopQueryKeys.gfsChildren(
      'test-environment:user-1:team-1',
      'folder-complete',
      'main',
      0
    )
    let unmount: () => void = () => {}
    try {
      const view = render(<FilesPage pendingGfsUri="gfs://main/complete-listing" />, {
        wrapper: wrapper(client),
      })
      unmount = view.unmount
      await screen.findByRole('button', { name: 'Options for old-report.txt' })
      await screen.findByRole('alertdialog')
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: key })
      })
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(childReads).toBe(2)
      expect(
        client.getQueryData<{ pages: Array<{ items: unknown[] }> }>(key)?.pages[0]?.items
      ).toEqual([])
      expect(screen.queryByRole('button', { name: 'Options for old-report.txt' })).toBeNull()
    } finally {
      unmount()
      client.clear()
    }
  })

  it('retires an omitted child only when every full-refetch cursor page is marked', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-provenance', 'Reports', { gfsUri: 'gfs://main/provenance' })
    )
    const row = childView('row-provenance', 'old-report.txt', 'file', {
      parentResourceId: 'folder-provenance',
    })
    const pages = [
      await listChildrenPage([row], 'cursor-2'),
      await listChildrenPage([]),
      await listChildrenPage([], 'cursor-2'),
      await listChildrenPage([]),
    ]
    let childReads = 0
    const listChildren = vi.fn(async (_parent: string, _drive: string, pageParam?: string) => {
      const index = childReads++
      if (index === 0) return pages[0]
      if (index === 1 && pageParam === 'cursor-2') return pages[1]
      if (index === 2) return pages[2]
      return pages[3]
    })
    const permissions = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'row-provenance')
        return Promise.reject(new Error('503 permission service unavailable'))
      return Promise.resolve(heldPermissionResponse(['read']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () =>
            listAccessiblePage([accessibleResource('folder-provenance', 'Reports', 'directory')])
          ),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => permissions(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const key = desktopQueryKeys.gfsChildren(
      'test-environment:user-1:team-1',
      'folder-provenance',
      'main',
      0
    )
    let unmount: () => void = () => {}
    try {
      const view = render(<FilesPage pendingGfsUri="gfs://main/provenance" />, {
        wrapper: wrapper(client),
      })
      unmount = view.unmount
      await screen.findByRole('button', { name: 'Options for old-report.txt' })
      await screen.findByRole('alertdialog')
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
      })
      await waitFor(() =>
        expect(client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(2)
      )
      expect(childReads).toBe(2)
      expect(screen.getByRole('alertdialog')).toBeTruthy()

      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: key })
      })
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))

      expect(childReads).toBe(4)
      expect(client.getQueryData<{ pages: Array<{ items: unknown[] }> }>(key)?.pages).toEqual([
        expect.objectContaining({ items: [] }),
        expect.objectContaining({ items: [] }),
      ])
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Options for old-report.txt' })).toBeNull()
    } finally {
      unmount()
      client.clear()
    }
  })

  it('keeps the recovery dialog until a paginated Files listing reaches a terminal cursor', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-cursor', 'Reports', { gfsUri: 'gfs://main/cursor-listing' })
    )
    const row = childView('row-cursor', 'older-report.txt', 'file', {
      parentResourceId: 'folder-cursor',
    })
    const pages = [
      await listChildrenPage([row], 'cursor-2'),
      await listChildrenPage([]),
      await listChildrenPage([], 'cursor-2'),
      await listChildrenPage([], 'cursor-3'),
      await listChildrenPage([]),
    ]
    let childReads = 0
    const listChildren = vi.fn(async (_parent: string, _drive: string, pageParam?: string) => {
      const index = childReads++
      if (index === 0) return pages[0]
      if (index === 1 && pageParam === 'cursor-2') return pages[1]
      if (pageParam === 'cursor-3') return pages[4]
      if (pageParam === undefined) return pages[2]
      return pages[3]
    })
    const permissions = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'row-cursor')
        return Promise.reject(new Error('503 permission service unavailable'))
      return Promise.resolve(heldPermissionResponse(['read']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () =>
            listAccessiblePage([accessibleResource('folder-cursor', 'Reports', 'directory')])
          ),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => permissions(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const key = desktopQueryKeys.gfsChildren(
      'test-environment:user-1:team-1',
      'folder-cursor',
      'main',
      0
    )
    let unmount: () => void = () => {}
    try {
      const view = render(<FilesPage pendingGfsUri="gfs://main/cursor-listing" />, {
        wrapper: wrapper(client),
      })
      unmount = view.unmount
      await screen.findByRole('button', { name: 'Options for older-report.txt' })
      await screen.findByRole('alertdialog')
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
      })
      await waitFor(() =>
        expect(client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(2)
      )
      expect(childReads).toBe(2)

      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: key })
      })
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))

      expect(childReads).toBe(4)
      expect(client.getQueryData<{ pages: Array<{ items: unknown[] }> }>(key)?.pages).toEqual([
        expect.objectContaining({ items: [] }),
        expect.objectContaining({ items: [] }),
      ])
      expect(screen.queryByRole('button', { name: 'Options for older-report.txt' })).toBeNull()
      expect(screen.getByRole('alertdialog').textContent).toContain('older-report.txt')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
      })
      await waitFor(() => expect(childReads).toBe(5))
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))
      const completedPages = client.getQueryData<{
        pages: Array<{ items: unknown[]; nextCursor: string | null }>
        pageParams: unknown[]
      }>(key)
      expect(completedPages?.pages).toHaveLength(3)
      expect(completedPages?.pageParams).toHaveLength(3)
      expect(completedPages?.pages.at(-1)?.nextCursor).toBeNull()
      expect(screen.getByRole('alertdialog').textContent).toContain('older-report.txt')
    } finally {
      unmount()
      client.clear()
    }
  })
})
