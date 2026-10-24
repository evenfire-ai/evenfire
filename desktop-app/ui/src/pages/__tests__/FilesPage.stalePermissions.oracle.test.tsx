// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New name' })).toBeTruthy()
    expect(renameResource).not.toHaveBeenCalled()
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Shared folder' }))
    })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('shared-folder', 'main'))

    const menu = screen.getByRole('menu', { name: 'Actions for Shared folder' })
    expect.soft(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect.soft(listAccessible).toHaveBeenCalledTimes(2)
    client.clear()
  })
})
