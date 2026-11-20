// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesResult,
  childView,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation'
import { FilesPage } from '../FilesPage'

// Share runs on an explicit target, never on the browser location. These
// tests mock only the preload bridge: the real controller, the real access
// hook and the real dialog decide which resource each ACL read and write names.

const SESSION_GENERATION = 1
const MANAGE = ['read', 'write', 'manage_acl', 'share']

function authFor(teamId: string): AuthContextValue {
  return {
    isAuthenticated: true,
    sessionGeneration: SESSION_GENERATION,
    me: {
      id: 'user-a',
      email: 'a@example.test',
      name: 'User A',
      picture: null,
      teamId,
      teamName: teamId,
      role: 'member' as const,
    },
    runtimeConfigState: null,
  } as unknown as AuthContextValue
}

const testQueryClients: QueryClient[] = []

type Resolved = Awaited<ReturnType<typeof resolveResource>>

interface Drive {
  roots: Record<string, Awaited<ReturnType<typeof listAccessiblePage>>>
  children: Record<string, Awaited<ReturnType<typeof listChildrenPage>>>
  resolved: Record<string, Resolved>
}

async function installBridge(drive: Drive, team: { current: string }) {
  const held = await affordancesResult(heldAffordances(MANAGE))
  const authority = delegationAffordances(new Set(held.held), held.isOperator)
  const emptyChildren = await listChildrenPage([])
  const noGrants = await grantsListPage([])
  const noShares = await sharesListPage([])
  const gfs = {
    listAccessible: vi.fn(async () => drive.roots[team.current] ?? listAccessiblePage([])),
    listChildren: vi.fn(async (resourceId: string) => drive.children[resourceId] ?? emptyChildren),
    resolve: vi.fn(async (uri: string) => {
      const resource = drive.resolved[uri.replace(/^gfs:\/\/main\//, '')]
      if (!resource) throw new Error(`404 Not Found: ${uri}`)
      return resource
    }),
    affordances: vi.fn(async (_resourceId: string) => authority),
    listGrants: vi.fn(async () => noGrants),
    listShares: vi.fn(async (_resourceId: string) => noShares),
    grant: vi.fn(async () => undefined),
  }
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs,
      auth: { getSessionGeneration: vi.fn(async () => SESSION_GENERATION) },
      agents: {
        listMine: vi.fn(async () => [
          {
            name: 'chatllm',
            contextRef: 'ctx-1',
            mcpServers: [],
            gfsSubject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
          },
        ]),
      },
      team: { directory: vi.fn(async () => ({ currentTeamId: team.current, items: [] })) },
    },
  })
  return gfs
}

function renderPage(team: { current: string }) {
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  testQueryClients.push(queryClient)
  const session: { switchTo: (teamId: string) => void } = { switchTo: () => undefined }
  function Harness() {
    const [teamId, setTeamId] = useState(team.current)
    session.switchTo = next => {
      team.current = next
      setTeamId(next)
    }
    return (
      <AuthContext.Provider value={authFor(teamId)}>
        <FilesPage />
      </AuthContext.Provider>
    )
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  )
  return { queryClient, session }
}

const folderRoot = (resourceId: string, name: string) =>
  accessibleResource(resourceId, name, 'directory', {
    sources: ['grant'],
    permissions: MANAGE,
    coversDescendants: true,
  })

function aclReadTargets(gfs: Awaited<ReturnType<typeof installBridge>>) {
  return new Set(gfs.listShares.mock.calls.map(([resourceId]) => resourceId))
}

afterEach(() => {
  cleanup()
  testQueryClients.forEach(queryClient => queryClient.clear())
  testQueryClients.length = 0
  vi.restoreAllMocks()
})

describe('FilesPage Share target', () => {
  it('shares a child folder of the open folder, reading and writing the child, not the folder', async () => {
    const team = { current: 'team-a' }
    const gfs = await installBridge(
      {
        roots: { 'team-a': await listAccessiblePage([folderRoot('folder-a', 'Folder A')]) },
        children: {
          'folder-a': await listChildrenPage([
            childView('folder-b', 'Folder B', 'directory', { parentResourceId: 'folder-a' }),
          ]),
        },
        resolved: {
          'folder-a': await resolveResource(resolvedDirectory('folder-a', 'Folder A')),
          'folder-b': await resolveResource(
            resolvedDirectory('folder-b', 'Folder B', { parentResourceId: 'folder-a' })
          ),
        },
      },
      team
    )
    renderPage(team)

    fireEvent.click(await screen.findByRole('button', { name: 'Folder A' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Share Folder B' }))
    const dialog = await screen.findByRole('dialog', { name: /^Share folder / })
    // The child's own direct shares are read; the open folder's never are
    // (its grants are read only by the inherited-access walk).
    await waitFor(() => expect(aclReadTargets(gfs)).toEqual(new Set(['folder-b'])))
    expect(dialog.getAttribute('aria-label')).toBe('Share folder Folder B')

    const picker = within(dialog).getByRole('combobox', { name: 'Add people, teams, or agents' })
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'chatllm' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /chatllm/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))

    await waitFor(() => expect(gfs.grant).toHaveBeenCalledOnce())
    expect(gfs.grant).toHaveBeenCalledWith(
      'folder-b',
      ['host:1st:mcp-host/chatllm'],
      ['read'],
      'main',
      true
    )
    // The browser stays in the folder it was in.
    expect(screen.getByRole('button', { name: 'Share Folder B' })).toBeTruthy()
  })

  it('re-reads the target authority every time Share opens on it', async () => {
    const team = { current: 'team-a' }
    const gfs = await installBridge(
      {
        roots: { 'team-a': await listAccessiblePage([folderRoot('folder-a', 'Folder A')]) },
        children: {},
        resolved: {
          'folder-a': await resolveResource(resolvedDirectory('folder-a', 'Folder A')),
        },
      },
      team
    )
    renderPage(team)
    const authorityReads = () =>
      gfs.affordances.mock.calls.filter(([resourceId]) => resourceId === 'folder-a').length

    const openShare = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Share Folder A' }))
      const dialog = await screen.findByRole('dialog', { name: 'Share folder Folder A' })
      await within(dialog).findByRole('combobox', { name: 'Add people, teams, or agents' })
      await waitFor(() => expect(screen.queryByText('Checking permissions…')).toBeNull())
      return dialog
    }
    const closeShare = async (dialog: HTMLElement) => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close share dialog' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }

    await closeShare(await openShare())
    const afterFirstOpen = authorityReads()
    expect(afterFirstOpen).toBeGreaterThan(0)

    await closeShare(await openShare())
    // The cached authority may predate a permission change: reopening reads
    // it again even though the cache already holds a result.
    await waitFor(() => expect(authorityReads()).toBeGreaterThan(afterFirstOpen))
  })

  describe('across a session change', () => {
    async function teamDrive(
      team: { current: string },
      teamARoots: ReturnType<typeof folderRoot>[]
    ) {
      return installBridge(
        {
          roots: {
            'team-a': await listAccessiblePage(teamARoots),
            'team-b': await listAccessiblePage([folderRoot('folder-b', 'Team B folder')]),
          },
          children: {
            'folder-a': await listChildrenPage([
              childView('file-a', 'team-a-report.txt', 'file', { parentResourceId: 'folder-a' }),
            ]),
          },
          resolved: {
            'folder-a': await resolveResource(resolvedDirectory('folder-a', 'Team A folder')),
            'folder-b': await resolveResource(resolvedDirectory('folder-b', 'Team B folder')),
            'folder-shared': await resolveResource(
              resolvedDirectory('folder-shared', 'Shared folder')
            ),
            'file-a': await resolveResource(
              resolvedFile('file-a', 'team-a-report.txt', { parentResourceId: 'folder-a' })
            ),
          },
        },
        team
      )
    }

    it('never restores a file Share location of the replaced session', async () => {
      const team = { current: 'team-a' }
      const gfs = await teamDrive(team, [folderRoot('folder-a', 'Team A folder')])
      const { session } = renderPage(team)

      fireEvent.click(await screen.findByRole('button', { name: 'Team A folder' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Share team-a-report.txt' }))
      expect(
        await screen.findByRole('dialog', { name: 'Share file team-a-report.txt' })
      ).toBeTruthy()
      await waitFor(() => expect(aclReadTargets(gfs)).toEqual(new Set(['file-a'])))

      await act(async () => session.switchTo('team-b'))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      fireEvent.click(await screen.findByRole('button', { name: 'Share Team B folder' }))
      const dialog = await screen.findByRole('dialog', { name: 'Share folder Team B folder' })
      await waitFor(() => expect(aclReadTargets(gfs)).toEqual(new Set(['file-a', 'folder-b'])))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close share dialog' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      expect(screen.queryByText('Team A folder')).toBeNull()
      expect(screen.queryByText('team-a-report.txt')).toBeNull()
      expect(
        (screen.getByRole('button', { name: 'Shared with me' }) as HTMLButtonElement).disabled
      ).toBe(true)
    })

    it('drops the replaced session Share location before any later dialog can restore it', async () => {
      const team = { current: 'team-a' }
      await teamDrive(team, [folderRoot('folder-a', 'Team A folder')])
      const { session } = renderPage(team)

      fireEvent.click(await screen.findByRole('button', { name: 'Team A folder' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Share team-a-report.txt' }))
      expect(
        await screen.findByRole('dialog', { name: 'Share file team-a-report.txt' })
      ).toBeTruthy()

      await act(async () => session.switchTo('team-b'))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      // The new session moves into a folder of its own.
      fireEvent.click(await screen.findByRole('button', { name: 'Team B folder' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Options for Team B folder' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'New folder' }))
      const newFolderDialog = await screen.findByRole('dialog', { name: 'New folder' })
      fireEvent.click(within(newFolderDialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      expect(screen.queryByText('Team A folder')).toBeNull()
      expect(screen.queryByText('team-a-report.txt')).toBeNull()
    })

    it('closes a folder Share opened under the replaced session', async () => {
      const team = { current: 'team-a' }
      const gfs = await teamDrive(team, [folderRoot('folder-shared', 'Shared folder')])
      const { session } = renderPage(team)

      fireEvent.click(await screen.findByRole('button', { name: 'Share Shared folder' }))
      expect(await screen.findByRole('dialog', { name: 'Share folder Shared folder' })).toBeTruthy()
      await waitFor(() => expect(aclReadTargets(gfs)).toEqual(new Set(['folder-shared'])))
      const readsBeforeSwitch = gfs.listShares.mock.calls.length

      await act(async () => session.switchTo('team-b'))

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(await screen.findByRole('button', { name: 'Share Team B folder' })).toBeTruthy()
      // The closed dialog's target is never read again under the new session.
      expect(gfs.listShares.mock.calls.length).toBe(readsBeforeSwitch)
    })
  })
})
