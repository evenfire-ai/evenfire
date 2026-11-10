// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesFailureMessage,
  affordancesResult,
  gfsRouteFailureMessage,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import { delegationAffordances } from '../../../../src/gfs/delegation'
import type { TeamDirectoryResult } from '../../../../src/types'
import { FilesPage } from '../FilesPage'

const SESSION_SCOPE = ':user-a:team-a'
const SESSION_GENERATION = 1
const SESSION_TOKEN = 'fixture-session-token'
const AFFORDANCES_KEY = desktopQueryKeys.gfsAffordances(
  SESSION_SCOPE,
  'folder-a',
  'main',
  SESSION_GENERATION
)
const authValue = {
  isAuthenticated: true,
  sessionGeneration: SESSION_GENERATION,
  me: {
    id: 'user-a',
    email: 'a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member' as const,
  },
  runtimeConfigState: null,
} as unknown as AuthContextValue

const testQueryClients: QueryClient[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function createPage(
  grant: ReturnType<typeof vi.fn>,
  options: { heldPermissions?: string[]; teamDirectory?: TeamDirectoryResult } = {}
) {
  const rootPage = await listAccessiblePage([
    accessibleResource('folder-a', 'Folder A', 'directory', {
      sources: ['grant'],
      permissions: ['read', 'manage_acl'],
      coversDescendants: true,
    }),
  ])
  const emptyChildrenPage = await listChildrenPage([])
  const resolvedFolder = await resolveResource(resolvedDirectory('folder-a', 'Folder A'))
  const heldPositive = await affordancesResult(
    heldAffordances(options.heldPermissions ?? ['read', 'write', 'manage_acl', 'share'])
  )
  const heldDenied = await affordancesResult(heldAffordances(['read']))
  const freshPositive = delegationAffordances(new Set(heldPositive.held), heldPositive.isOperator)
  const freshDenied = delegationAffordances(new Set(heldDenied.held), heldDenied.isOperator)
  let nextPermissionRefresh: Promise<typeof freshPositive> | null = null
  const affordances = vi.fn(() => {
    const nextRefresh = nextPermissionRefresh
    nextPermissionRefresh = null
    return nextRefresh ?? Promise.resolve(freshPositive)
  })
  const pushToast = vi.fn()
  const listGrants = vi.fn(async () => grantsListPage([]))

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        listAccessible: vi.fn(async () => rootPage),
        listChildren: vi.fn(async () => emptyChildrenPage),
        affordances,
        grant,
        resolve: vi.fn(async () => resolvedFolder),
        listGrants,
        listShares: vi.fn(async () => sharesListPage([])),
      },
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
      team: {
        directory: vi.fn(
          async () => options.teamDirectory ?? { currentTeamId: 'team-a', items: [] }
        ),
      },
    },
  })

  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  testQueryClients.push(queryClient)
  const view = render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <FilesPage pushToast={pushToast} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
  await screen.findByRole('button', { name: 'Share Folder A' })
  fireEvent.click(screen.getByRole('button', { name: 'Share Folder A' }))
  const dialog = await screen.findByRole('dialog', { name: 'Share folder Folder A' })
  await waitFor(() => {
    expect(queryClient.getQueryState(AFFORDANCES_KEY)?.status).toBe('success')
    expect(queryClient.getQueryState(AFFORDANCES_KEY)?.fetchStatus).toBe('idle')
  })

  return {
    ...view,
    affordances,
    dialog,
    freshDenied,
    freshPositive,
    listGrants,
    pushToast,
    queryClient,
    setNextPermissionRefresh: (refresh: Promise<typeof freshPositive>) => {
      nextPermissionRefresh = refresh
    },
  }
}

async function selectAgent(dialog: HTMLElement) {
  const input = within(dialog).getByRole('combobox', { name: 'Add people, teams, or agents' })
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'chatllm' } })
  fireEvent.click(await within(dialog).findByRole('option', { name: /chatllm/ }))
  return input
}

async function setEditorRole(dialog: HTMLElement) {
  const role = within(dialog).getByRole('button', { name: 'Access role for selected recipients' })
  fireEvent.click(role)
  fireEvent.click(await within(dialog).findByRole('option', { name: 'Editor' }))
  return role
}

function startPermissionRefresh(queryClient: QueryClient) {
  act(() => {
    void queryClient.invalidateQueries({ exact: true, queryKey: AFFORDANCES_KEY })
  })
  return waitFor(() =>
    expect(queryClient.getQueryState(AFFORDANCES_KEY)?.fetchStatus).toBe('fetching')
  )
}

afterEach(() => {
  cleanup()
  testQueryClients.forEach(queryClient => queryClient.clear())
  testQueryClients.length = 0
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

describe('FilesPage delegation request lifecycle', () => {
  it('requires an explicit role after positive authority removes Editor', async () => {
    const grant = vi.fn().mockResolvedValue(undefined)
    const { dialog, freshPositive, queryClient, setNextPermissionRefresh } = await createPage(grant)
    const reducedHeld = await affordancesResult(heldAffordances(['read', 'manage_acl']))
    const reducedPositive = delegationAffordances(new Set(reducedHeld.held), reducedHeld.isOperator)

    await selectAgent(dialog)
    const role = await setEditorRole(dialog)
    expect(role.textContent).toContain('Editor')

    const reducedPermission = deferred<typeof freshPositive>()
    setNextPermissionRefresh(reducedPermission.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => reducedPermission.resolve(reducedPositive))
    await waitFor(() => expect(queryClient.getQueryData(AFFORDANCES_KEY)).toEqual(reducedPositive))

    const share = within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement
    expect(role.textContent).not.toContain('Editor')
    fireEvent.click(share)
    expect(grant).not.toHaveBeenCalled()
    expect(within(dialog).getByText('Choose an available role before sharing.')).toBeTruthy()
    expect(share.disabled).toBe(true)
    expect(within(dialog).getByText('chatllm')).toBeTruthy()
    expect(
      within(dialog).getByRole('checkbox', { name: 'Include contents of this folder' })
    ).toHaveProperty('checked', true)

    fireEvent.click(role)
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Read' }))
    expect(role.textContent).toContain('Read')
    expect(within(dialog).queryByText('Choose an available role before sharing.')).toBeNull()
    expect(share.disabled).toBe(false)
    fireEvent.click(share)
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())
    expect(grant).toHaveBeenCalledWith(
      'folder-a',
      ['host:1st:mcp-host/chatllm'],
      ['read'],
      'main',
      true
    )
  })

  it('invalidates Editor when selected subject types remove that role option', async () => {
    const grant = vi.fn().mockResolvedValue(undefined)
    const teamDirectory: TeamDirectoryResult = {
      currentTeamId: 'team-a',
      items: [
        {
          team: { id: 'team-a', name: 'Team A', role: 'member' },
          members: [
            {
              id: 'user-b',
              email: 'b@example.test',
              name: 'User B',
              role: 'member',
              status: 'active',
            },
          ],
          contextIds: [],
          agentNames: [],
        },
      ],
    }
    const { dialog } = await createPage(grant, {
      heldPermissions: ['read', 'delete', 'manage_acl'],
      teamDirectory,
    })

    const picker = within(dialog).getByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'User B' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /User B/ }))
    const role = await setEditorRole(dialog)
    expect(role.textContent).toContain('Editor')

    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'chatllm' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /chatllm/ }))

    const share = within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement
    expect(role.textContent).not.toContain('Editor')
    expect(within(dialog).getByText('Choose an available role before sharing.')).toBeTruthy()
    expect(share.disabled).toBe(true)
    expect(within(dialog).getByText('User B')).toBeTruthy()
    expect(within(dialog).getByText('chatllm')).toBeTruthy()
    fireEvent.click(share)
    expect(grant).not.toHaveBeenCalled()

    fireEvent.click(role)
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Read' }))
    fireEvent.click(share)
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())
    expect(grant).toHaveBeenCalledWith(
      'folder-a',
      ['user:user-b', 'host:1st:mcp-host/chatllm'],
      ['read'],
      'main',
      true
    )
  })

  it('does not restore a retired Share failure after positive authority returns', async () => {
    const oldGrant = deferred<void>()
    const grant = vi.fn().mockImplementationOnce(() => oldGrant.promise)
    const { dialog, freshDenied, freshPositive, queryClient, setNextPermissionRefresh } =
      await createPage(grant)
    const grantFailure = await gfsRouteFailureMessage(
      client =>
        client.grant(
          {
            resourceId: 'folder-a',
            drive: 'main',
            subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
            permissions: ['read'],
            inherit: true,
          },
          SESSION_TOKEN
        ),
      503,
      { code: 'internal', message: 'late old share attempt failed' }
    )

    await selectAgent(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())

    const denial = deferred<typeof freshPositive>()
    setNextPermissionRefresh(denial.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => denial.resolve(freshDenied))
    expect(await within(dialog).findByText('Read-only access')).toBeTruthy()
    expect(within(dialog).getByText('People with access')).toBeTruthy()

    const restored = deferred<typeof freshPositive>()
    setNextPermissionRefresh(restored.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => restored.resolve(freshPositive))
    const restoredInput = await within(dialog).findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })

    await act(async () => oldGrant.reject(new Error(grantFailure)))
    await waitFor(() => expect((restoredInput as HTMLInputElement).disabled).toBe(false))
    expect(within(dialog).queryByText(/late old share attempt failed/)).toBeNull()
    expect(within(dialog).queryByText('chatllm')).toBeNull()
    expect(within(dialog).getByText('People with access')).toBeTruthy()
    expect(grant).toHaveBeenCalledOnce()
  })

  it('ignores a late rejected Share result after authority retires the draft', async () => {
    const oldGrant = deferred<void>()
    const grant = vi
      .fn()
      .mockImplementationOnce(() => oldGrant.promise)
      .mockResolvedValue(undefined)
    const { dialog, freshDenied, freshPositive, pushToast, queryClient, setNextPermissionRefresh } =
      await createPage(grant)
    const grantFailure = await gfsRouteFailureMessage(
      client =>
        client.grant(
          {
            resourceId: 'folder-a',
            drive: 'main',
            subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
            permissions: ['read', 'write'],
            inherit: false,
          },
          SESSION_TOKEN
        ),
      503,
      { code: 'internal', message: 'late old share attempt failed' }
    )

    await selectAgent(dialog)
    const role = await setEditorRole(dialog)
    const inheritance = within(dialog).getByRole('checkbox', {
      name: 'Include contents of this folder',
    }) as HTMLInputElement
    fireEvent.click(inheritance)
    expect(role.textContent).toContain('Editor')
    expect(inheritance.checked).toBe(false)

    const share = within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement
    fireEvent.click(share)
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1))
    expect(grant).toHaveBeenCalledWith(
      'folder-a',
      ['host:1st:mcp-host/chatllm'],
      ['read', 'write'],
      'main',
      false
    )
    expect(share.disabled).toBe(true)
    fireEvent.click(share)
    expect(grant).toHaveBeenCalledTimes(1)

    const pendingPermission = deferred<typeof freshPositive>()
    setNextPermissionRefresh(pendingPermission.promise)
    await startPermissionRefresh(queryClient)
    expect(within(dialog).getByText('chatllm')).toBeTruthy()
    expect(within(dialog).getByText('Checking permissions…')).toBeTruthy()
    expect(share.disabled).toBe(true)
    fireEvent.click(share)
    expect(grant).toHaveBeenCalledTimes(1)

    const permissionFailure = await affordancesFailureMessage(
      503,
      { code: 'internal', message: 'permission check unavailable' },
      'folder-a'
    )
    await act(async () => pendingPermission.reject(new Error(permissionFailure)))
    expect(await screen.findByText(/permission check unavailable/)).toBeTruthy()
    expect(within(dialog).getByText('chatllm')).toBeTruthy()
    expect(role.textContent).toContain('Editor')
    expect(inheritance.checked).toBe(false)
    expect(grant).toHaveBeenCalledTimes(1)

    const denial = deferred<typeof freshPositive>()
    setNextPermissionRefresh(denial.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => denial.resolve(freshDenied))
    expect(await within(dialog).findByText('Read-only access')).toBeTruthy()
    expect(within(dialog).getByText('People with access')).toBeTruthy()
    expect(within(dialog).queryByText('chatllm')).toBeNull()
    expect(grant).toHaveBeenCalledTimes(1)

    const restored = deferred<typeof freshPositive>()
    setNextPermissionRefresh(restored.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => restored.resolve(freshPositive))
    const restoredInput = await within(dialog).findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    expect((restoredInput as HTMLInputElement).disabled).toBe(true)
    expect(within(dialog).queryByText('chatllm')).toBeNull()

    await act(async () => oldGrant.reject(new Error(grantFailure)))
    await waitFor(() => expect((restoredInput as HTMLInputElement).disabled).toBe(false))
    expect(within(dialog).queryByText(/late old share attempt failed/)).toBeNull()
    expect(within(dialog).getByText('People with access')).toBeTruthy()
    expect(pushToast).not.toHaveBeenCalled()

    await selectAgent(dialog)
    const freshRole = await setEditorRole(dialog)
    const freshInheritance = within(dialog).getByRole('checkbox', {
      name: 'Include contents of this folder',
    }) as HTMLInputElement
    expect(freshRole.textContent).toContain('Editor')
    expect(freshInheritance.checked).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(pushToast).toHaveBeenCalledOnce())
    expect(within(dialog).queryByText(/late old share attempt failed/)).toBeNull()
  })

  it('does not publish success feedback for a late successful Share after authority denial', async () => {
    const oldGrant = deferred<void>()
    const grant = vi.fn().mockImplementationOnce(() => oldGrant.promise)
    const {
      dialog,
      freshDenied,
      freshPositive,
      listGrants,
      pushToast,
      queryClient,
      setNextPermissionRefresh,
    } = await createPage(grant)

    await selectAgent(dialog)
    await setEditorRole(dialog)
    const inheritance = within(dialog).getByRole('checkbox', {
      name: 'Include contents of this folder',
    }) as HTMLInputElement
    fireEvent.click(inheritance)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())

    const denial = deferred<typeof freshPositive>()
    setNextPermissionRefresh(denial.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => denial.resolve(freshDenied))
    expect(await within(dialog).findByText('Read-only access')).toBeTruthy()
    expect(within(dialog).getByText('People with access')).toBeTruthy()
    await waitFor(() => expect(listGrants).toHaveBeenCalledOnce())
    const grantListReadsBeforeOldSuccess = listGrants.mock.calls.length

    await act(async () => oldGrant.resolve())
    expect(pushToast).not.toHaveBeenCalled()
    expect(within(dialog).getByText('Read-only access')).toBeTruthy()
    expect(within(dialog).getByText('People with access')).toBeTruthy()
    expect(within(dialog).queryByText('chatllm')).toBeNull()
    expect(grant).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(listGrants).toHaveBeenCalledTimes(grantListReadsBeforeOldSuccess + 1)
    )

    const restored = deferred<typeof freshPositive>()
    setNextPermissionRefresh(restored.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => restored.resolve(freshPositive))
    const restoredInput = await within(dialog).findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    expect((restoredInput as HTMLInputElement).disabled).toBe(false)
    expect(within(dialog).queryByText('chatllm')).toBeNull()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('does not publish a late Share result when denial settles after the dialog closes', async () => {
    const oldGrant = deferred<void>()
    const grant = vi.fn().mockImplementationOnce(() => oldGrant.promise)
    const {
      freshDenied,
      freshPositive,
      listGrants,
      pushToast,
      queryClient,
      setNextPermissionRefresh,
    } = await createPage(grant)

    const initialDialog = await screen.findByRole('dialog', { name: 'Share folder Folder A' })
    await selectAgent(initialDialog)
    fireEvent.click(within(initialDialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())

    fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close share dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(await screen.findByRole('button', { name: 'Share Folder A' }))
    const restoredDialog = await screen.findByRole('dialog', { name: 'Share folder Folder A' })
    const denial = deferred<typeof freshPositive>()
    setNextPermissionRefresh(denial.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => denial.resolve(freshDenied))
    await waitFor(() => expect(queryClient.getQueryData(AFFORDANCES_KEY)).toEqual(freshDenied))
    expect(within(restoredDialog).getByText('Read-only access')).toBeTruthy()
    await waitFor(() => expect(listGrants).toHaveBeenCalled())
    const grantListReadsBeforeOldSuccess = listGrants.mock.calls.length

    await act(async () => oldGrant.resolve())
    expect(within(restoredDialog).getByText('Read-only access')).toBeTruthy()
    expect(within(restoredDialog).getByText('People with access')).toBeTruthy()
    expect(within(restoredDialog).queryByText('chatllm')).toBeNull()
    expect(pushToast).not.toHaveBeenCalled()
    expect(grant).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(listGrants).toHaveBeenCalledTimes(grantListReadsBeforeOldSuccess + 1)
    )

    const positive = deferred<typeof freshPositive>()
    setNextPermissionRefresh(positive.promise)
    await startPermissionRefresh(queryClient)
    await act(async () => positive.resolve(freshPositive))
    expect(
      within(restoredDialog).getByRole('combobox', {
        name: 'Add people, teams, or agents',
      })
    ).toBeTruthy()
    expect(within(restoredDialog).getByText('People with access')).toBeTruthy()
    expect(within(restoredDialog).queryByText('chatllm')).toBeNull()
    expect(within(restoredDialog).queryByRole('button', { name: 'Share' })).toBeNull()
    expect(pushToast).not.toHaveBeenCalled()
  })
})
