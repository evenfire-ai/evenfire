// @vitest-environment jsdom
import type { ComponentType, ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  openPreviewTab,
  refreshPreviewTab,
} from '@lib/workspaceTabs'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'
import type { FilePreviewPageProps } from '../FilePreviewPage.types'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
const id = '0123456789abcdef0123456789abcdef'
const PreviewWithRenameCallback = FilePreviewPage as unknown as ComponentType<
  FilePreviewPageProps & {
    onRenameCommitted?: (gfsUri: string) => void | Promise<void>
  }
>

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function installPreviewRenameFixture(sessionScope: string, gfs: Record<string, unknown>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs,
    },
  })
  hookMock.useGfsBrowserController.mockReset()
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope,
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  } as never)
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

describe('preview rename refreshes the workspace title from GFS', () => {
  it('updates the exact preview tab title without changing its selection or URI', async () => {
    let serverName = 'diagram.png'
    let serverVersion = 7
    const resolve = vi.fn(async (requestedUri: string) =>
      resolveResource({
        resourceId: id,
        rid: id,
        gfsUri: requestedUri,
        drive: 'main',
        parentResourceId: 'source-parent',
        name: serverName,
        kind: 'file',
        version: serverVersion,
        bytes: 3,
      })
    )
    const renameResource = vi.fn(async (_resourceId: string, name: string) => {
      serverName = name
      serverVersion += 1
    })
    const renamedUris: string[] = []
    const affordances = vi.fn(async () =>
      delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
    )
    const queryClient = installPreviewRenameFixture('preview-rename-user:main', {
      resolve,
      renameResource,
      affordances,
      downloadPreview: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]).buffer,
      })),
    })

    function Harness() {
      const [tabs, setTabs] = useState(() =>
        openPreviewTab(createWorkspaceTabsState('chat-tab'), {
          id: 'preview-tab',
          title: 'diagram.png',
          gfsUri: uri,
          fileKind: 'image',
          byteLength: 3,
          resourceVersion: 7,
        })
      )
      const activeTab = activeWorkspaceTab(tabs)
      const onRenameCommitted = async (changedUri: string) => {
        renamedUris.push(changedUri)
        const resource = await window.clerum.gfs.resolve(changedUri)
        if (resource.kind !== 'file') return
        setTabs(state =>
          refreshPreviewTab(state, changedUri, {
            status: 'available',
            title: resource.name,
            fileKind: 'image',
            byteLength: resource.bytes ?? 0,
            resourceVersion: resource.version,
          })
        )
      }
      const props = {
        gfsUri: uri,
        fileName: activeTab?.title ?? 'Preview',
        fileKind: 'image' as const,
        mimeType: 'image/png',
        byteLength: 3,
        onRenameCommitted,
      }
      const client = queryClient
      return (
        <QueryClientProvider client={client}>
          <div data-testid="active-tab-id">{tabs.activeTabId}</div>
          <div data-testid="active-tab-uri">{activeTab?.preview?.gfsUri}</div>
          <div data-testid="active-tab-title">{activeTab?.title}</div>
          <PreviewWithRenameCallback {...props} />
        </QueryClientProvider>
      )
    }

    render(<Harness />)

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalled())
    const titleRow = screen
      .getByRole('heading', { name: 'diagram.png', level: 2 })
      .closest('.da-gfs-preview-title-row')
    if (!titleRow) throw new Error('Preview title actions were not rendered')
    fireEvent.click(
      within(titleRow as HTMLElement).getByRole('button', { name: 'Options for diagram.png' })
    )
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Actions for diagram.png' })).getByRole('menuitem', {
        name: 'Rename',
      })
    )
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'renamed.png' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('active-tab-title').textContent).toBe('renamed.png')
    )
    expect(screen.getByRole('heading', { name: 'renamed.png', level: 2 })).toBeTruthy()
    expect(screen.getByTestId('active-tab-id').textContent).toBe('preview-tab')
    expect(screen.getByTestId('active-tab-uri').textContent).toBe(uri)
    expect(renamedUris).toEqual([uri])
    expect(resolve).toHaveBeenCalledWith(uri)
    expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull()
  })
})

describe('FilePreviewPage unchanged rename', () => {
  it('closes without mutation or success feedback when the normalized name is unchanged', async () => {
    const renameResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    const affordances = vi.fn(async () => delegationAffordances(new Set(['read', 'write']), false))
    const queryClient = installPreviewRenameFixture('preview-rename-noop-user:main', {
      resolve: vi.fn(async () =>
        resolveResource({
          resourceId: id,
          rid: id,
          gfsUri: uri,
          drive: 'main',
          parentResourceId: 'parent',
          name: 'diagram.png',
          kind: 'file',
          version: 7,
          bytes: 1,
        })
      ),
      affordances,
      downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
      renameResource,
    })

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      }
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(id, 'main'))
    fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
    expect((within(dialog).getByLabelText('New name') as HTMLInputElement).value).toBe(
      'diagram.png'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull())
    expect(renameResource).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalled()
    queryClient.clear()
  })
})
