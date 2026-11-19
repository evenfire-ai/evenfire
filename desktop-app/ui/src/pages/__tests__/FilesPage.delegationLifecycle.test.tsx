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
  resolvedFile,
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
  options: {
    heldPermissions?: string[]
    teamDirectory?: TeamDirectoryResult
    grants?: Awaited<ReturnType<typeof grantsListPage>>
    listGrants?: ReturnType<typeof vi.fn>
    shares?: Awaited<ReturnType<typeof sharesListPage>>
    gfs?: Record<string, unknown>
    onLocationChange?: (gfsUri: string | null, name: string | null) => void
  } = {}
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
  const grants = options.grants ?? (await grantsListPage([]))
  const listGrants = options.listGrants ?? vi.fn(async () => grants)
  const getSessionGeneration = vi.fn(async () => SESSION_GENERATION)

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
        listShares: vi.fn(async () => options.shares ?? sharesListPage([])),
        ...options.gfs,
      },
      auth: { getSessionGeneration },
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
        <FilesPage pushToast={pushToast} onLocationChange={options.onLocationChange} />
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
    getSessionGeneration,
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

  it('starts no grant once main runs another session, and grants once it matches again', async () => {
    const grant = vi.fn().mockResolvedValue(undefined)
    const { dialog, getSessionGeneration } = await createPage(grant)
    getSessionGeneration.mockResolvedValue(SESSION_GENERATION + 1)

    await selectAgent(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(getSessionGeneration).toHaveBeenCalled())
    await act(async () => {})
    expect(grant).not.toHaveBeenCalled()

    getSessionGeneration.mockResolvedValue(SESSION_GENERATION)
    if (!within(dialog).queryByRole('button', { name: 'Share' })) await selectAgent(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())
    expect(grant).toHaveBeenCalledWith(
      'folder-a',
      ['host:1st:mcp-host/chatllm'],
      ['read'],
      'main',
      true
    )
  })

  it('starts no grant when Share closes while the session is being confirmed', async () => {
    const grant = vi.fn().mockResolvedValue(undefined)
    const { dialog, getSessionGeneration } = await createPage(grant)
    const confirmation = deferred<number>()
    getSessionGeneration.mockImplementationOnce(() => confirmation.promise)

    await selectAgent(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(getSessionGeneration).toHaveBeenCalledOnce())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close share dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => confirmation.resolve(SESSION_GENERATION))

    expect(grant).not.toHaveBeenCalled()
  })

  it('starts no role change once main runs another session, and changes it once it matches', async () => {
    const grant = vi.fn().mockResolvedValue(undefined)
    const agentGrant = await grantsListPage([
      {
        id: '42424242-4242-4242-4242-424242424242',
        drive: 'main',
        resourceId: 'folder-a',
        subject: { type: 'host', id: '1st:mcp-host/chatllm' },
        permissions: ['read'],
        inherit: true,
      },
    ])
    const { getSessionGeneration } = await createPage(grant, { grants: agentGrant })
    getSessionGeneration.mockResolvedValue(SESSION_GENERATION + 1)

    fireEvent.click(await screen.findByRole('button', { name: 'Access role for chatllm' }))
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    await waitFor(() => expect(getSessionGeneration).toHaveBeenCalled())
    await act(async () => {})
    expect(grant).not.toHaveBeenCalled()

    getSessionGeneration.mockResolvedValue(SESSION_GENERATION)
    fireEvent.click(await screen.findByRole('button', { name: 'Access role for chatllm' }))
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith(
        'folder-a',
        ['host:1st:mcp-host/chatllm'],
        ['read', 'write'],
        'main',
        true
      )
    )
  })

  it('shows a rate-limited access list as a failure with Retry, never as an empty one', async () => {
    const rateLimited = await gfsRouteFailureMessage(
      client => client.listGrants({ resourceId: 'folder-a' }, SESSION_TOKEN),
      429,
      { code: 'rate_limited', message: 'Too many requests' },
      { 'retry-after': '30' }
    )
    const listed = await grantsListPage([])
    const listGrants = vi
      .fn()
      .mockRejectedValueOnce(new Error(rateLimited))
      .mockResolvedValue(listed)
    const grant = vi.fn().mockResolvedValue(undefined)
    const { dialog } = await createPage(grant, { listGrants })

    const retry = await within(dialog).findByRole('button', { name: 'Retry' })
    expect(within(dialog).getByTestId('gfs-access-list-error')).toBeTruthy()
    expect(within(dialog).queryByText('No one has access yet.')).toBeNull()
    // The browser behind the dialog keeps its listing: no Files rate-limit card.
    expect(screen.getByRole('button', { name: 'Share Folder A' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()

    fireEvent.click(retry)
    expect(await within(dialog).findByText('No one has access yet.')).toBeTruthy()
    expect(listGrants).toHaveBeenCalledTimes(2)
  })

  it('shares a listing row in place, without moving the browser into it', async () => {
    const onLocationChange = vi.fn()
    const grant = vi.fn().mockResolvedValue(undefined)
    const { dialog } = await createPage(grant, { onLocationChange })

    expect(dialog).toBeTruthy()
    const sharedWithMe = screen.getByRole('button', { name: 'Shared with me' }) as HTMLButtonElement
    expect(sharedWithMe.disabled).toBe(true)
    expect(onLocationChange).not.toHaveBeenCalledWith(expect.stringContaining('folder'), 'Folder A')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close share dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sharedWithMe.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Share Folder A' })).toBeTruthy()
    expect(onLocationChange).not.toHaveBeenCalledWith(expect.stringContaining('folder'), 'Folder A')
  })

  it('opens a file row before sharing it, and returns to the listing on close', async () => {
    const rootPage = await listAccessiblePage([
      accessibleResource('file-a', 'Report.pdf', 'file', {
        sources: ['grant'],
        permissions: ['read', 'manage_acl'],
      }),
    ])
    const held = await affordancesResult(heldAffordances(['read', 'manage_acl']))
    const file = await resolveResource(resolvedFile('file-a', 'Report.pdf'))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => SESSION_GENERATION) },
        gfs: {
          listAccessible: vi.fn(async () => rootPage),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () =>
            delegationAffordances(new Set(held.held), held.isOperator)
          ),
          resolve: vi.fn(async () => file),
          listGrants: vi.fn(async () => grantsListPage([])),
          listShares: vi.fn(async () => sharesListPage([])),
        },
        agents: { listMine: vi.fn(async () => []) },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-a', items: [] })) },
      },
    })
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    testQueryClients.push(queryClient)
    const onLocationChange = vi.fn()
    render(
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={queryClient}>
          <FilesPage onLocationChange={onLocationChange} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Share Report.pdf' }))
    const dialog = await screen.findByRole('dialog', { name: 'Share file Report.pdf' })
    await waitFor(() => expect(onLocationChange).toHaveBeenCalledWith(file.gfsUri, 'Report.pdf'))
    const sharedWithMe = screen.getByRole('button', { name: 'Shared with me' }) as HTMLButtonElement
    expect(sharedWithMe.disabled).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close share dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(sharedWithMe.disabled).toBe(true))
    expect(await screen.findByRole('button', { name: 'Share Report.pdf' })).toBeTruthy()
  })

  it('starts no grant removal once main runs another session, and removes it once it matches', async () => {
    const grantId = '42424242-4242-4242-4242-424242424242'
    const agentGrant = await grantsListPage([
      {
        id: grantId,
        drive: 'main',
        resourceId: 'folder-a',
        subject: { type: 'host', id: '1st:mcp-host/chatllm' },
        permissions: ['read'],
        inherit: true,
      },
    ])
    const revokeGrant = vi.fn().mockResolvedValue(undefined)
    const { getSessionGeneration } = await createPage(vi.fn(), {
      grants: agentGrant,
      gfs: { revokeGrant },
    })
    getSessionGeneration.mockResolvedValue(SESSION_GENERATION + 1)

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    await waitFor(() => expect(getSessionGeneration).toHaveBeenCalled())
    await act(async () => {})
    expect(revokeGrant).not.toHaveBeenCalled()

    getSessionGeneration.mockResolvedValue(SESSION_GENERATION)
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith(grantId))
  })

  it('starts no share removal once main runs another session, and removes it once it matches', async () => {
    const shareId = '43434343-4343-4343-4343-434343434343'
    const agentShare = await sharesListPage([
      {
        id: shareId,
        drive: 'main',
        resourceId: 'folder-a',
        subject: { type: 'host', id: '1st:mcp-host/chatllm' },
        permissions: ['read'],
        includeDescendants: true,
      },
    ])
    const revokeShare = vi.fn().mockResolvedValue(undefined)
    const { getSessionGeneration } = await createPage(vi.fn(), {
      shares: agentShare,
      gfs: { revokeShare },
    })
    getSessionGeneration.mockResolvedValue(SESSION_GENERATION + 1)

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    await waitFor(() => expect(getSessionGeneration).toHaveBeenCalled())
    await act(async () => {})
    expect(revokeShare).not.toHaveBeenCalled()

    getSessionGeneration.mockResolvedValue(SESSION_GENERATION)
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith(shareId))
  })

  describe('write outcome toasts across a session switch in main', () => {
    const GRANT_ID = '42424242-4242-4242-4242-424242424242'
    const SHARE_ID = '43434343-4343-4343-4343-434343434343'
    const agentGrantRow = {
      id: GRANT_ID,
      drive: 'main',
      resourceId: 'folder-a',
      subject: { type: 'host', id: '1st:mcp-host/chatllm' },
      permissions: ['read'],
      inherit: true,
    }
    const agentShareRow = {
      id: SHARE_ID,
      drive: 'main',
      resourceId: 'folder-a',
      subject: { type: 'host', id: '1st:mcp-host/chatllm' },
      permissions: ['read'],
      includeDescendants: true,
    }

    type Write = ReturnType<typeof deferred<void>>
    const settle = () =>
      act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    interface Case {
      name: string
      success: string
      mount: (write: ReturnType<typeof vi.fn>) => Promise<Awaited<ReturnType<typeof createPage>>>
      start: (dialog: HTMLElement) => Promise<void>
    }
    const removeAccess = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    }
    const cases: Case[] = [
      {
        name: 'grant',
        success: 'Access granted to 1 subject',
        mount: write => createPage(write),
        start: async dialog => {
          await selectAgent(dialog)
          fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
        },
      },
      {
        name: 'role change',
        success: 'chatllm is now an Editor',
        mount: async write => createPage(write, { grants: await grantsListPage([agentGrantRow]) }),
        start: async () => {
          fireEvent.click(await screen.findByRole('button', { name: 'Access role for chatllm' }))
          fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
        },
      },
      {
        name: 'grant removal',
        success: 'Access revoked for chatllm',
        mount: async write =>
          createPage(vi.fn(), {
            grants: await grantsListPage([agentGrantRow]),
            gfs: { revokeGrant: write },
          }),
        start: removeAccess,
      },
      {
        name: 'share removal',
        success: 'Shared access revoked for chatllm',
        mount: async write =>
          createPage(vi.fn(), {
            shares: await sharesListPage([agentShareRow]),
            gfs: { revokeShare: write },
          }),
        start: removeAccess,
      },
    ]

    const runWrite = async (testCase: Case, switchSessionMidWrite: boolean) => {
      const write: Write = deferred<void>()
      const ipc = vi.fn(() => write.promise)
      const page = await testCase.mount(ipc)
      await testCase.start(page.dialog)
      await waitFor(() => expect(ipc).toHaveBeenCalledOnce())
      if (switchSessionMidWrite) page.getSessionGeneration.mockResolvedValue(SESSION_GENERATION + 1)
      const confirmationsBeforeSettle = page.getSessionGeneration.mock.calls.length
      await act(async () => write.resolve())
      await settle()
      return { ...page, confirmationsBeforeSettle }
    }

    for (const testCase of cases) {
      it(`shows no ${testCase.name} toast once main runs another session`, async () => {
        const { pushToast, getSessionGeneration, confirmationsBeforeSettle } = await runWrite(
          testCase,
          true
        )
        expect(pushToast).not.toHaveBeenCalled()
        // The settled write did reach its outcome: it asked main before deciding.
        expect(getSessionGeneration.mock.calls.length).toBeGreaterThan(confirmationsBeforeSettle)
      })

      it(`shows the ${testCase.name} toast while the session is unchanged`, async () => {
        const { pushToast } = await runWrite(testCase, false)
        await waitFor(() =>
          expect(pushToast).toHaveBeenCalledWith(
            expect.stringContaining(testCase.success),
            'success'
          )
        )
      })
    }

    for (const testCase of cases.filter(({ name }) => name === 'grant' || name === 'role change')) {
      it(`settles the ${testCase.name} without waiting for main to confirm its toast`, async () => {
        const write = deferred<void>()
        const ipc = vi.fn(() => write.promise)
        const page = await testCase.mount(ipc)
        await testCase.start(page.dialog)
        await waitFor(() => expect(ipc).toHaveBeenCalledOnce())
        const confirmation = deferred<number>()
        page.getSessionGeneration.mockImplementation(() => confirmation.promise)
        const listsBefore = page.listGrants.mock.calls.length

        await act(async () => write.resolve())

        // The list re-reads and the row's role control is usable again while
        // main has still not answered whether the toast may be shown.
        await waitFor(() => expect(page.listGrants.mock.calls.length).toBeGreaterThan(listsBefore))
        if (testCase.name === 'role change') {
          await waitFor(() =>
            expect(
              (screen.getByRole('button', { name: 'Access role for chatllm' }) as HTMLButtonElement)
                .disabled
            ).toBe(false)
          )
        }
        expect(page.pushToast).not.toHaveBeenCalled()

        await act(async () => confirmation.resolve(SESSION_GENERATION))
        await waitFor(() =>
          expect(page.pushToast).toHaveBeenCalledWith(
            expect.stringContaining(testCase.success),
            'success'
          )
        )
      })
    }

    const failedWrites = [
      {
        name: 'role change',
        reject: (client: Parameters<Parameters<typeof gfsRouteFailureMessage>[0]>[0]) =>
          client.grant(
            {
              resourceId: 'folder-a',
              subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
              permissions: ['read', 'write'],
            },
            SESSION_TOKEN
          ),
      },
      {
        name: 'grant removal',
        reject: (client: Parameters<Parameters<typeof gfsRouteFailureMessage>[0]>[0]) =>
          client.revokeGrant(GRANT_ID, SESSION_TOKEN),
      },
      {
        name: 'share removal',
        reject: (client: Parameters<Parameters<typeof gfsRouteFailureMessage>[0]>[0]) =>
          client.revokeShare(SHARE_ID, SESSION_TOKEN),
      },
    ]

    for (const failedWrite of failedWrites) {
      const testCase = cases.find(({ name }) => name === failedWrite.name)!
      for (const switchSessionMidWrite of [true, false]) {
        it(`${switchSessionMidWrite ? 'shows no' : 'shows the'} ${failedWrite.name} failure toast ${
          switchSessionMidWrite
            ? 'once main runs another session'
            : 'while the session is unchanged'
        }`, async () => {
          const failure = await gfsRouteFailureMessage(failedWrite.reject, 500, {
            code: 'internal',
            message: 'upstream failed',
          })
          const write = deferred<void>()
          const ipc = vi.fn(() => write.promise)
          const { dialog, getSessionGeneration, pushToast } = await testCase.mount(ipc)
          await testCase.start(dialog)
          await waitFor(() => expect(ipc).toHaveBeenCalledOnce())
          if (switchSessionMidWrite) getSessionGeneration.mockResolvedValue(SESSION_GENERATION + 1)
          const confirmationsBeforeSettle = getSessionGeneration.mock.calls.length

          await act(async () => write.reject(new Error(failure)))
          await settle()

          if (switchSessionMidWrite) {
            expect(pushToast).not.toHaveBeenCalled()
          } else {
            expect(pushToast).toHaveBeenCalledWith(expect.any(String), 'error')
          }
          expect(getSessionGeneration.mock.calls.length).toBeGreaterThan(confirmationsBeforeSettle)
        })
      }
    }

    it('still reports a write that settles after Share closes in the same session', async () => {
      const write = deferred<void>()
      const revokeGrant = vi.fn(() => write.promise)
      const { dialog, pushToast } = await createPage(vi.fn(), {
        grants: await grantsListPage([agentGrantRow]),
        gfs: { revokeGrant },
      })
      await removeAccess()
      await waitFor(() => expect(revokeGrant).toHaveBeenCalledOnce())
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close share dialog' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await act(async () => write.resolve())
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith('Access revoked for chatllm', 'success')
      )
    })
  })
})
