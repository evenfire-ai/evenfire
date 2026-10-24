// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  accessibleResource,
  listAccessiblePage,
  resolveResource,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import type { Tone } from '@/uiTypes'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
const parentId = 'source-parent'
const fullAccess = delegationAffordances(
  new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
  false
)
const readOnly = delegationAffordances(new Set(['read']), false)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function installGfs(options: {
  source?: () => Promise<ReturnType<typeof delegationAffordances>>
  destination?: () => Promise<ReturnType<typeof delegationAffordances>>
  move?: (...args: unknown[]) => Promise<void>
  listAccessible?: () => Promise<unknown>
}) {
  const resource = resolveResource({
    resourceId: '0123456789abcdef0123456789abcdef',
    rid: '0123456789abcdef0123456789abcdef',
    gfsUri: uri,
    drive: 'main',
    parentResourceId: parentId,
    name: 'diagram.png',
    kind: 'file',
    version: 7,
    bytes: 1,
  })
  const resolve = vi.fn(async () => resource)
  const affordances = vi.fn(async (resourceId: string) => {
    if (resourceId === parentId) return (options.source ?? (async () => fullAccess))()
    if (resourceId === 'destination-1') {
      return (options.destination ?? (async () => fullAccess))()
    }
    return fullAccess
  })
  const moveResource = vi.fn(options.move ?? (async () => undefined))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolve,
        affordances,
        listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
        downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        moveResource,
        listAccessible: options.listAccessible ?? (async () => ({ items: [], nextCursor: null })),
      },
    },
  })
  return { affordances, moveResource, resolve }
}

function renderPreview(pushToast?: (message: string, tone: Tone) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

function installController() {
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-test-user:main',
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
}

async function openPreviewActions() {
  const heading = await screen.findByRole('heading', { name: 'diagram.png', level: 2 })
  const titleRow = heading.closest('.da-gfs-preview-title-row')
  if (!titleRow) throw new Error('Preview title actions are unavailable')
  fireEvent.click(
    within(titleRow as HTMLElement).getByRole('button', { name: 'Options for diagram.png' })
  )
  return screen.getByRole('menu', { name: 'Actions for diagram.png' })
}

describe('FilePreviewPage move permission contract', () => {
  it('hides Move when the source parent has read and write but lacks delete', async () => {
    const sourceReadWrite = delegationAffordances(new Set(['read', 'write']), false)
    installGfs({ source: async () => sourceReadWrite })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()

    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
  })

  it('hides Move when the source parent has read and delete but lacks write', async () => {
    const sourceReadDelete = delegationAffordances(new Set(['read', 'delete']), false)
    installGfs({ source: async () => sourceReadDelete })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()

    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
  })

  it('allows Move from a write/delete parent even when the file itself is read-only', async () => {
    const sourceWriteDelete = delegationAffordances(new Set(['write', 'delete']), false)
    installGfs({ source: async () => sourceWriteDelete, destination: async () => readOnly })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()

    expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
  })

  it('hides Move until the source parent has server-derived write and delete bits', async () => {
    const { affordances } = installGfs({ source: async () => readOnly })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(affordances).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef', 'main')
    )
    const menu = await openPreviewActions()

    await waitFor(() =>
      expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    )
  })

  it('keeps Move hidden while the parent permission check is pending or unavailable', async () => {
    let finishSourceCheck!: (value: ReturnType<typeof delegationAffordances>) => void
    const sourceCheck = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      finishSourceCheck = resolve
    })
    const { affordances } = installGfs({ source: () => sourceCheck })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(parentId, 'main'))
    const menu = await openPreviewActions()
    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()

    await act(async () => finishSourceCheck(fullAccess))
    await waitFor(() =>
      expect(
        within(screen.getByRole('menu', { name: 'Actions for diagram.png' })).getByRole(
          'menuitem',
          { name: 'Move to' }
        )
      ).toBeTruthy()
    )
  })

  it('keeps server destination authorization authoritative and reports a denied destination', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read'],
      }),
    ])
    const moveResource = vi.fn(async () => undefined)
    installGfs({
      destination: async () => readOnly,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('You do not have write access to the destination folder.')
    ).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('rejects a cached destination grant when fresh confirmation sees write revoked', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const moveResource = vi.fn(async () => undefined)
    const { affordances } = installGfs({
      destination: async () => readOnly,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const { queryClient } = renderPreview()
    queryClient.setQueryData(
      desktopQueryKeys.gfsAffordances('preview-test-user:main', 'destination-1', 'main'),
      fullAccess
    )

    await screen.findByAltText('Preview of diagram.png')
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('You do not have write access to the destination folder.')
    ).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith(parentId, 'main')
    expect(affordances).toHaveBeenCalledWith('destination-1', 'main')
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('keeps a confirmed move visible while fresh source-parent permissions are pending', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let sourceCalls = 0
    let finishSourceRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    const moveResource = vi.fn(async () => undefined)
    const { affordances } = installGfs({
      source: () => {
        sourceCalls += 1
        if (sourceCalls !== 2) return Promise.resolve(fullAccess)
        return new Promise(resolve => {
          finishSourceRefresh = resolve
        })
      },
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const { queryClient } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(parentId, 'main'))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move here (Archive)' })).toBeTruthy()
    )

    void queryClient.invalidateQueries({
      predicate: query => query.queryKey.includes(parentId),
    })
    await waitFor(() => expect(sourceCalls).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Move here (Archive)' }))
    const checkingVisible = Boolean(screen.queryByText('Checking permissions…'))

    await act(async () => finishSourceRefresh(fullAccess))
    expect(checkingVisible).toBe(true)
    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith(
        '0123456789abcdef0123456789abcdef',
        'destination-1',
        'main',
        7
      )
    )
    expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
  })

  it('holds a source 429 retry until its Retry-After window expires', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let sourceCalls = 0
    const limited = new Error(
      "Error invoking remote method 'gfs:affordances': 429 Too Many Requests " +
        'httpStatus=429 retryAfterSeconds=7'
    )
    const source = vi.fn(async () => {
      sourceCalls += 1
      if (sourceCalls === 2) throw limited
      return fullAccess
    })
    const moveResource = vi.fn(async () => undefined)
    installGfs({ source, listAccessible: async () => destinationPage, move: moveResource })
    installController()
    const { queryClient } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(sourceCalls).toBe(1))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('Too many file requests — try again in 7s.')
    ).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sourceCalls).toBe(2)
    expect(moveResource).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001)
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })
    expect(moveResource).toHaveBeenCalledTimes(1)
    queryClient.clear()
  })

  it('does not let a successful permission retry commit Move without a second confirmation', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const limited = new Error(
      "Error invoking remote method 'gfs:affordances': 429 Too Many Requests " +
        'httpStatus=429 retryAfterSeconds=7'
    )
    let destinationCalls = 0
    const destination = vi.fn(async () => {
      destinationCalls += 1
      if (destinationCalls === 1) throw limited
      return fullAccess
    })
    const moveResource = vi.fn(async () => undefined)
    const { affordances } = installGfs({
      destination,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const { queryClient } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(parentId, 'main'))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('Too many file requests — try again in 7s.')
    ).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith(parentId, 'main')
    expect(affordances).toHaveBeenCalledWith('destination-1', 'main')
    expect(moveResource).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001)
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })
    expect(destination).toHaveBeenCalledTimes(2)
    expect.soft(moveResource).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('rejects a permission response after the preview resource changes', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let finishDestinationCheck!: (value: ReturnType<typeof delegationAffordances>) => void
    const destination = vi.fn(
      () =>
        new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
          finishDestinationCheck = resolve
        })
    )
    const moveResource = vi.fn(async () => undefined)
    const { resolve } = installGfs({
      destination,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const renderPage = (activeUri = uri, activeFileName = 'diagram.png') => (
      <QueryClientProvider client={queryClient}>
        <FilePreviewPage
          gfsUri={activeUri}
          fileName={activeFileName}
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
          pushToast={vi.fn()}
        />
      </QueryClientProvider>
    )
    const view = render(renderPage())

    await screen.findByAltText('Preview of diagram.png')
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move here (Archive)' })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() => expect(destination).toHaveBeenCalledOnce())
    expect(within(dialog).getByText('Checking permissions…')).toBeTruthy()

    const nextUri = 'gfs://main/abcdefabcdefabcdefabcdefabcdefab'
    const nextResource = await resolveResource({
      resourceId: 'abcdefabcdefabcdefabcdefabcdefab',
      rid: 'abcdefabcdefabcdefabcdefabcdefab',
      gfsUri: nextUri,
      drive: 'main',
      parentResourceId: 'source-parent-2',
      name: 'replacement.png',
      kind: 'file',
      version: 8,
      bytes: 1,
    })
    resolve.mockResolvedValue(nextResource)
    view.rerender(renderPage(nextUri, 'replacement.png'))
    await screen.findByRole('heading', { name: 'replacement.png', level: 2 })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
    )
    await act(async () => finishDestinationCheck(fullAccess))

    expect(resolve).toHaveBeenLastCalledWith(nextUri)
    expect(moveResource).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('moves with exact resource version after both parent and destination checks pass', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const moveResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    renderPreview(pushToast)

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith(
        '0123456789abcdef0123456789abcdef',
        'destination-1',
        'main',
        7
      )
    )
    expect(pushToast).toHaveBeenCalledWith('Moved diagram.png to Archive', 'success')
    expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
  })
})
