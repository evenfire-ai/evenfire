// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '0123456789abcdef0123456789abcdef'
const resourceUri = `gfs://main/${resourceId}`
const queryClients: QueryClient[] = []

function renderWithPermissions(resourceBits: string[], parentBits: string[]) {
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-permissions-user:main',
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  queryClients.push(queryClient)
  const resolve = vi.fn(async () =>
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
    })
  )
  const affordances = vi.fn(async (id: string) =>
    delegationAffordances(new Set(id === 'preview-parent' ? parentBits : resourceBits), false)
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
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
  return { affordances, view }
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
  return screen.getByRole('menu', { name: 'Actions for diagram.png' })
}

describe('FilePreviewPage permission-derived actions', () => {
  afterEach(() => {
    cleanup()
    for (const queryClient of queryClients.splice(0)) queryClient.clear()
    vi.restoreAllMocks()
  })

  it('gates Share, Rename, Move, and Delete from resource and parent affordances', async () => {
    const readOnly = renderWithPermissions(['read'], ['read'])
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await screen.findByRole('button', { name: 'Options for diagram.png' })
    const readOnlyMenu = openMenu()
    expect(within(readOnlyMenu).queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(within(readOnlyMenu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    expect(within(readOnlyMenu).queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    fireEvent.click(within(readOnlyMenu).getByRole('menuitem', { name: 'Share' }))
    const readOnlyShareMenu = screen.getByRole('menu', {
      name: 'Share options for diagram.png',
    })
    expect(within(readOnlyShareMenu).queryByRole('menuitem', { name: 'Share' })).toBeNull()
    expect(within(readOnlyShareMenu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    expect(within(readOnlyShareMenu).getByRole('menuitem', { name: 'Copy file ID' })).toBeTruthy()
    expect(readOnly.affordances).toHaveBeenCalledWith(resourceId, 'main')
    readOnly.view.unmount()

    const parentAuthorized = renderWithPermissions(['read'], ['read', 'write', 'delete'])
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() =>
      expect(parentAuthorized.affordances).toHaveBeenCalledWith('preview-parent', 'main')
    )
    const parentAuthorizedMenu = openMenu()
    expect(within(parentAuthorizedMenu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
    expect(within(parentAuthorizedMenu).queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(within(parentAuthorizedMenu).queryByRole('menuitem', { name: 'Delete' })).toBeNull()
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
    expect(within(ownerMenu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(within(ownerMenu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
    expect(within(ownerMenu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    fireEvent.click(within(ownerMenu).getByRole('menuitem', { name: 'Share' }))
    const ownerShareMenu = screen.getByRole('menu', { name: 'Share options for diagram.png' })
    expect(within(ownerShareMenu).getByRole('menuitem', { name: 'Share' })).toBeTruthy()
  })
})
