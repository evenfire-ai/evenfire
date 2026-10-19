// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  accessibleResource,
  listAccessiblePage,
  resolveResource,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
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
  const affordances = vi.fn(async (resourceId: string) => {
    if (resourceId === parentId) return (options.source ?? (async () => fullAccess))()
    return (options.destination ?? (async () => fullAccess))()
  })
  const moveResource = vi.fn(options.move ?? (async () => undefined))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolve: vi.fn(async () => resource),
        affordances,
        downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        moveResource,
        listAccessible: options.listAccessible ?? (async () => ({ items: [], nextCursor: null })),
      },
    },
  })
  return { affordances, moveResource }
}

function renderPreview(pushToast?: (message: string, tone: 'success' | 'error') => void) {
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
