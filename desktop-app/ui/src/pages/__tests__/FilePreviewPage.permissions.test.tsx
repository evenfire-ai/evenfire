// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  grantsListPage,
  listGrantsFailureMessage,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import type { Tone } from '@/uiTypes'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { expectUnavailable, isMenuItemEnabled } from '../../test/gfsMenuItemState'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '0123456789abcdef0123456789abcdef'
const resourceUri = `gfs://main/${resourceId}`
const queryClients: QueryClient[] = []
const activeAffordances = delegationAffordances(
  new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
  false
)

function controller() {
  return {
    accessState: 'active' as const,
    sessionScope: 'preview-test-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  }
}

function renderWithPermissions(
  resourceBits: string[],
  parentBits: string[],
  resolved: () => Promise<Awaited<ReturnType<typeof resolveResource>>> = () =>
    resolveResource({
      resourceId,
      rid: resourceId,
      gfsUri: resourceUri,
      drive: 'main',
      parentResourceId: 'preview-parent',
      name: 'diagram.png',
      kind: 'file',
      version: 7,
      bytes: 1,
    }),
  queryDefaults: ConstructorParameters<typeof QueryClient>[0] = {
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  }
) {
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-permissions-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
  const queryClient = new QueryClient(queryDefaults)
  queryClients.push(queryClient)
  const resolve = vi.fn(resolved)
  const affordances = vi.fn(async (id: string) =>
    delegationAffordances(new Set(id === 'preview-parent' ? parentBits : resourceBits), false)
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: {
        downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        resolve,
        affordances,
      },
    },
  })
  const view = render(
    <FilePreviewPage
      gfsUri={resourceUri}
      fileName="diagram.png"
      fileKind="image"
      mimeType="image/png"
      byteLength={1}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    }
  )
  return { affordances, queryClient, resolve, view }
}

/** The labels of the items a menu offers, in order. */
function offeredLabels(menu: HTMLElement) {
  return within(menu)
    .queryAllByRole('menuitem')
    .map(item => item.textContent)
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
  return screen.getByRole('menu', { name: 'Actions for diagram.png' })
}

type InheritedAccessProducers = {
  resolve: (uri: string) => Promise<unknown>
  listGrants: (id: string, drive?: string) => Promise<unknown>
  listShares: (id: string, drive?: string) => Promise<unknown>
  grant?: (...args: Parameters<typeof window.clerum.gfs.grant>) => Promise<void>
  affordances?: (...args: Parameters<typeof window.clerum.gfs.affordances>) => Promise<unknown>
  agents?: () => Promise<unknown[]>
  pushToast?: (message: string, tone: Tone) => void
}

async function openShareDialogWithInheritedAccess(producers: InheritedAccessProducers) {
  const controllerState = controller()
  hookMock.useGfsBrowserController.mockReturnValue(controllerState)
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  queryClients.push(queryClient)
  const resolve = vi.fn(producers.resolve)
  const affordances = vi.fn(producers.affordances ?? (async () => activeAffordances))
  const listGrants = vi.fn(producers.listGrants)
  const listShares = vi.fn(producers.listShares)
  const grant = vi.fn(producers.grant ?? (async () => undefined))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: {
        downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        resolve,
        affordances,
        grant,
        listGrants,
        listShares,
      },
      team: { directory: vi.fn(async () => ({ currentTeamId: 'team-a', items: [] })) },
      agents: { listMine: vi.fn(producers.agents ?? (async () => [])) },
    },
  })
  render(
    <FilePreviewPage
      gfsUri={resourceUri}
      fileName="diagram.png"
      fileKind="image"
      mimeType="image/png"
      byteLength={1}
      pushToast={producers.pushToast}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    }
  )

  expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
  await waitFor(() => expect(affordances).toHaveBeenCalledWith(resourceId, 'main'))
  const menu = openMenu()
  fireEvent.click(within(menu).getByRole('menuitem', { name: /^Share$/ }))
  const shareMenu = screen.getByRole('menu', { name: 'Share options for diagram.png' })
  fireEvent.click(within(shareMenu).getByRole('menuitem', { name: /^Share$/ }))
  const dialog = await screen.findByRole('dialog', { name: 'Share file diagram.png' })
  return { controllerState, dialog, grant, listGrants, listShares, queryClient, resolve }
}

async function inheritedTarget(parentResourceId: string) {
  return resolveResource(
    resolvedFile(resourceId, 'diagram.png', {
      parentResourceId,
      version: 7,
    })
  )
}

async function inheritedParent(resourceId: string, name: string, parentResourceId: string | null) {
  return resolveResource(resolvedDirectory(resourceId, name, { parentResourceId }))
}

function inheritedShare(parentResourceId: string) {
  return {
    id: 'share-parent-1',
    drive: 'main',
    resourceId: parentResourceId,
    subject: { type: 'host', id: 'agent-inherited' },
    permissions: ['read'],
    includeDescendants: true,
  }
}

describe('FilePreviewPage permission-derived actions', () => {
  afterEach(() => {
    cleanup()
    for (const queryClient of queryClients.splice(0)) queryClient.clear()
    vi.restoreAllMocks()
  })

  it('suppresses a late Share success after same-session authority retires the Preview draft', async () => {
    let finishGrant!: () => void
    const oldGrant = new Promise<void>(resolve => {
      finishGrant = resolve
    })
    const grant = vi.fn(() => oldGrant)
    const pushToast = vi.fn()
    const deniedAffordances = delegationAffordances(new Set(['read']), false)
    let authorityDenied = false
    const affordances = vi.fn(async () => (authorityDenied ? deniedAffordances : activeAffordances))
    const { dialog, queryClient } = await openShareDialogWithInheritedAccess({
      resolve: async uri => {
        if (uri === resourceUri) return await inheritedTarget('preview-parent')
        if (uri === 'gfs://main/preview-parent') {
          return await inheritedParent('preview-parent', 'Parent folder', null)
        }
        throw new Error(`Unexpected resolve: ${uri}`)
      },
      listGrants: async () => grantsListPage([]),
      listShares: async () => sharesListPage([]),
      affordances,
      grant,
      agents: async () => [
        {
          name: 'chatllm',
          contextRef: 'ctx-1',
          mcpServers: [],
          gfsSubject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
        },
      ],
      pushToast,
    })

    const picker = within(dialog).getByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'chatllm' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /chatllm/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledOnce())

    authorityDenied = true
    await act(async () => {
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: desktopQueryKeys.gfsAffordances('preview-test-user:main', resourceId, 'main', 1),
      })
    })
    expect(await within(dialog).findByText('Read-only access')).toBeTruthy()

    await act(async () => finishGrant())
    expect(grant).toHaveBeenCalledOnce()
    expect(pushToast).not.toHaveBeenCalledWith('Access granted to 1 subject', 'success')
  })

  it('gates Share, Rename, Move, and Delete from resource and parent affordances', async () => {
    const readOnly = renderWithPermissions(['read'], ['read'])
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await screen.findByRole('button', { name: 'Options for diagram.png' })
    const readOnlyMenu = openMenu()
    for (const label of ['Rename', 'Move to', 'Delete']) {
      expectUnavailable(
        within(readOnlyMenu).getByRole('menuitem', { name: label }),
        `${label} isn't available`
      )
    }
    fireEvent.click(within(readOnlyMenu).getByRole('menuitem', { name: 'Share' }))
    const readOnlyShareMenu = screen.getByRole('menu', {
      name: 'Share options for diagram.png',
    })
    expect(
      within(readOnlyShareMenu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Share', 'Copy link'])
    expectUnavailable(
      within(readOnlyShareMenu).getByRole('menuitem', { name: 'Share' }),
      "Share isn't available"
    )
    expect(readOnly.affordances).toHaveBeenCalledWith(resourceId, 'main')
    readOnly.view.unmount()

    const parentAuthorized = renderWithPermissions(['read'], ['read', 'write', 'delete'])
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() =>
      expect(parentAuthorized.affordances).toHaveBeenCalledWith('preview-parent', 'main')
    )
    const parentAuthorizedMenu = openMenu()
    expect(
      isMenuItemEnabled(within(parentAuthorizedMenu).getByRole('menuitem', { name: 'Move to' }))
    ).toBe(true)
    expectUnavailable(
      within(parentAuthorizedMenu).getByRole('menuitem', { name: 'Rename' }),
      "Rename isn't available"
    )
    expectUnavailable(
      within(parentAuthorizedMenu).getByRole('menuitem', { name: 'Delete' }),
      "Delete isn't available"
    )
    expect(parentAuthorized.affordances).toHaveBeenCalledWith('preview-parent', 'main')
    parentAuthorized.view.unmount()

    const ownerAuthorized = renderWithPermissions(
      ['read', 'write', 'delete', 'manage_acl', 'share'],
      ['read']
    )
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await screen.findByRole('button', { name: 'Options for diagram.png' })
    await waitFor(() =>
      expect(ownerAuthorized.affordances).toHaveBeenCalledWith(resourceId, 'main')
    )
    const ownerMenu = openMenu()
    expect(isMenuItemEnabled(within(ownerMenu).getByRole('menuitem', { name: 'Rename' }))).toBe(
      true
    )
    expect(isMenuItemEnabled(within(ownerMenu).getByRole('menuitem', { name: 'Delete' }))).toBe(
      true
    )
    expectUnavailable(
      within(ownerMenu).getByRole('menuitem', { name: 'Move to' }),
      "Move to isn't available"
    )
    fireEvent.click(within(ownerMenu).getByRole('menuitem', { name: 'Share' }))
    const ownerShareMenu = screen.getByRole('menu', { name: 'Share options for diagram.png' })
    expect(isMenuItemEnabled(within(ownerShareMenu).getByRole('menuitem', { name: 'Share' }))).toBe(
      true
    )
  })

  it("keeps the file's own actions out of the menu when the preview URI resolves to a folder", async () => {
    const owner = ['read', 'write', 'delete', 'manage_acl', 'share']
    const { resolve } = renderWithPermissions(owner, owner, () =>
      resolveResource(
        resolvedDirectory(resourceId, 'diagram.png', { parentResourceId: 'preview-parent' })
      )
    )
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(resourceUri))
    await act(async () => {
      await resolve.mock.results[0]!.value
    })
    const menu = openMenu()
    // Witness: the menu still offers the actions that do not read the file's bits.
    expect(within(menu).getByRole('menuitem', { name: 'Copy content' })).toBeTruthy()
    for (const label of ['Rename', 'Move to', 'Download', 'Delete']) {
      expect(within(menu).queryByRole('menuitem', { name: label }), label).toBeNull()
    }
    // The Share entry stays only as the home of Copy link; Share itself is gone.
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Share$/ }))
    const shareMenu = screen.getByRole('menu', { name: 'Share options for diagram.png' })
    expect(offeredLabels(shareMenu)).toEqual(['Copy link'])
  })

  it('keeps Share, Rename and Delete out of a folder preview even with permissive folder bits cached', async () => {
    const owner = ['read', 'write', 'delete', 'manage_acl', 'share']
    let releaseResolve!: () => void
    const resolveGate = new Promise<void>(release => {
      releaseResolve = release
    })
    // App query defaults: the folder's cached bits outlive the moment nothing
    // observes them, as they do between the Files browser and a new tab.
    const { affordances, queryClient, resolve } = renderWithPermissions(
      owner,
      owner,
      async () => {
        await resolveGate
        return resolveResource(
          resolvedDirectory(resourceId, 'diagram.png', { parentResourceId: 'preview-parent' })
        )
      },
      { defaultOptions: desktopQueryDefaults }
    )
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(resourceUri))
    // The Files browser has already loaded the open folder's affordances under
    // this same key, through the same producer, by the time a preview tab is
    // opened on its URI; the preview reads whatever it finds there.
    const folderAffordancesKey = desktopQueryKeys.gfsAffordances(
      'preview-permissions-user:main',
      resourceId,
      'main',
      1
    )
    await act(async () => {
      await queryClient.fetchQuery({
        queryKey: folderAffordancesKey,
        queryFn: () => window.clerum.gfs.affordances(resourceId, 'main'),
      })
    })
    expect(affordances).toHaveBeenCalledWith(resourceId, 'main')
    await act(async () => {
      releaseResolve()
      await resolve.mock.results[0]!.value
      // Let the query layer's batched notification reach the page.
      await new Promise(settle => setTimeout(settle, 0))
    })
    // Witness: permissive folder bits are still in the cache the preview reads.
    expect(queryClient.getQueryData(folderAffordancesKey)).toMatchObject({ canDelegate: true })

    const menu = openMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Copy content' })).toBeTruthy()
    for (const label of ['Rename', 'Delete']) {
      expect(within(menu).queryByRole('menuitem', { name: label }), label).toBeNull()
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Share$/ }))
    const shareMenu = screen.getByRole('menu', { name: 'Share options for diagram.png' })
    expect(offeredLabels(shareMenu)).toEqual(['Copy link'])
  })

  it('leaves Move out of the menu for a resolved file with no parent folder', async () => {
    const owner = ['read', 'write', 'delete', 'manage_acl', 'share']
    const { affordances } = renderWithPermissions(owner, owner, () =>
      resolveResource(
        resolvedFile(resourceId, 'diagram.png', { parentResourceId: null, version: 7 })
      )
    )
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(resourceId, 'main'))
    const menu = openMenu()
    // Witness: the file resolved and its bits landed, so its own actions are live.
    await waitFor(() =>
      expect(isMenuItemEnabled(within(menu).getByRole('menuitem', { name: 'Rename' }))).toBe(true)
    )
    expect(isMenuItemEnabled(within(menu).getByRole('menuitem', { name: 'Delete' }))).toBe(true)
    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
  })

  it('renders inherited rows for a complete derivation without a coverage notice', async () => {
    const parentId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const target = await inheritedTarget(parentId)
    const parent = await inheritedParent(parentId, 'Parent folder', null)
    const shareRows = await sharesListPage([inheritedShare(parentId)])
    const resolve = async (uri: string) => {
      if (uri === resourceUri) return target
      if (uri === `gfs://main/${parentId}`) return parent
      throw new Error(`Unexpected resolve: ${uri}`)
    }
    const listGrants = async () => grantsListPage([])
    const listShares = async (id: string) => (id === parentId ? shareRows : sharesListPage([]))

    const { dialog } = await openShareDialogWithInheritedAccess({
      resolve,
      listGrants,
      listShares,
    })

    expect(
      await within(dialog).findByTestId('gfs-access-row-inherited-host:agent-inherited')
    ).toBeTruthy()
    expect(
      within(dialog).queryByText('There may be access from parent folders you cannot see.')
    ).toBeNull()
    expect(
      within(dialog).queryByText('Sharing details on some parent folders are not visible to you.')
    ).toBeNull()
    expect(
      within(dialog).queryByText(
        'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
      )
    ).toBeNull()
  })

  it('shows the read-boundary notice and hint without claiming the list is empty', async () => {
    const parentId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const target = await inheritedTarget(parentId)
    const deniedUri = `gfs://main/${parentId}`
    const deniedMessage = await resolveDeniedMessage(deniedUri)
    const resolve = async (uri: string) => {
      if (uri === resourceUri) return target
      if (uri === deniedUri) throw new Error(deniedMessage)
      throw new Error(`Unexpected resolve: ${uri}`)
    }
    const listGrants = async () => grantsListPage([])
    const listShares = async () => sharesListPage([])

    const { dialog } = await openShareDialogWithInheritedAccess({
      resolve,
      listGrants,
      listShares,
    })

    const notice = await within(dialog).findByText(
      'There may be access from parent folders you cannot see.'
    )
    expect(notice.closest('.status-banner')?.getAttribute('title')).toBe(
      'Some folders above this one are not visible to you. People may still have access through them, but we cannot show who.'
    )
    expect(within(dialog).queryByText('No one has access yet.')).toBeNull()
    expect(
      within(dialog).queryByText('Some access inherited from parent folders could not be loaded.')
    ).toBeNull()
  })

  it('retains visible inherited rows when parent ACL coverage is limited', async () => {
    const parentId = 'cccccccccccccccccccccccccccccccc'
    const target = await inheritedTarget(parentId)
    const parent = await inheritedParent(parentId, 'Readable parent', null)
    const deniedMessage = await listGrantsFailureMessage()
    const shareRows = await sharesListPage([inheritedShare(parentId)])
    const resolve = async (uri: string) => {
      if (uri === resourceUri) return target
      if (uri === `gfs://main/${parentId}`) return parent
      throw new Error(`Unexpected resolve: ${uri}`)
    }
    const listGrants = async (id: string) => {
      if (id === parentId) throw new Error(deniedMessage)
      return grantsListPage([])
    }
    const listShares = async (id: string) => (id === parentId ? shareRows : sharesListPage([]))

    const { dialog } = await openShareDialogWithInheritedAccess({
      resolve,
      listGrants,
      listShares,
    })

    expect(
      await within(dialog).findByTestId('gfs-access-row-inherited-host:agent-inherited')
    ).toBeTruthy()
    expect(
      within(dialog).getByText('Sharing details on some parent folders are not visible to you.')
    ).toBeTruthy()
    expect(
      within(dialog).queryByText('There may be access from parent folders you cannot see.')
    ).toBeNull()
    expect(within(dialog).queryByText('No one has access yet.')).toBeNull()
  })

  it('retains rows already derived before an unavailable ancestor stops the walk', async () => {
    const parentId = 'dddddddddddddddddddddddddddddddd'
    const rootId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const target = await inheritedTarget(parentId)
    const parent = await inheritedParent(parentId, 'Readable parent', rootId)
    const deniedUri = `gfs://main/${rootId}`
    const deniedMessage = await resolveDeniedMessage(
      deniedUri,
      { code: 'not_found', message: 'The resource was not found.' },
      404
    )
    const shareRows = await sharesListPage([inheritedShare(parentId)])
    const resolve = async (uri: string) => {
      if (uri === resourceUri) return target
      if (uri === `gfs://main/${parentId}`) return parent
      if (uri === deniedUri) throw new Error(deniedMessage)
      throw new Error(`Unexpected resolve: ${uri}`)
    }
    const listGrants = async () => grantsListPage([])
    const listShares = async (id: string) => (id === parentId ? shareRows : sharesListPage([]))

    const { dialog } = await openShareDialogWithInheritedAccess({
      resolve,
      listGrants,
      listShares,
    })

    expect(
      await within(dialog).findByTestId('gfs-access-row-inherited-host:agent-inherited')
    ).toBeTruthy()
    expect(
      within(dialog).getByText(
        'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
      )
    ).toBeTruthy()
    expect(within(dialog).queryByText('No one has access yet.')).toBeNull()
  })

  it('preserves the existing fail-closed error notice for session authority loss', async () => {
    const parentId = 'ffffffffffffffffffffffffffffffff'
    const target = await inheritedTarget(parentId)
    const deniedUri = `gfs://main/${parentId}`
    const deniedMessage = await resolveDeniedMessage(
      deniedUri,
      { code: 'unauthorized', message: 'The session is not authorized.' },
      401
    )
    const resolve = vi.fn(async (uri: string) => {
      if (uri === resourceUri) return target
      if (uri === deniedUri) throw new Error(deniedMessage)
      throw new Error(`Unexpected resolve: ${uri}`)
    })
    const listGrants = async () => grantsListPage([])
    const listShares = async () => sharesListPage([])

    const { controllerState, dialog } = await openShareDialogWithInheritedAccess({
      resolve,
      listGrants,
      listShares,
    })

    expect(
      await within(dialog).findByText(
        'Some access inherited from parent folders could not be loaded.'
      )
    ).toBeTruthy()
    await waitFor(() => expect(controllerState.handleAuthorityFailure).toHaveBeenCalled())
    expect(within(dialog).queryByText('No one has access yet.')).toBeNull()
  })
})
