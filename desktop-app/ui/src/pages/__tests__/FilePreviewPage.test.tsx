// @vitest-environment jsdom
import { type ReactNode, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import { EntityChangeRegistry } from '@lib/entityChangeRegistry'
import { resolveDeniedMessage, resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

function controller(
  accessState: 'active' | 'revoked' = 'active',
  handleAuthorityFailure: (message: string, surface?: 'discovery' | 'operation') => boolean = () =>
    false
) {
  return {
    accessState,
    sessionScope: 'preview-test-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(handleAuthorityFailure),
  }
}

const activeAffordances = delegationAffordances(
  new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
  false
)

async function resolvePreviewResource(gfsUri: string) {
  const resourceId = gfsUri.slice(gfsUri.lastIndexOf('/') + 1)
  return resolveResource({
    resourceId,
    rid: resourceId,
    gfsUri,
    drive: 'main',
    parentResourceId: 'preview-parent',
    name: 'preview resource',
    kind: 'file',
    version: 1,
    bytes: 3,
  })
}

const queryClients: QueryClient[] = []

function render(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  queryClients.push(queryClient)
  return renderWithTestingLibrary(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

// The producer (`window.clerum.gfs.downloadPreview`) returns `{ bytes: ArrayBuffer }`.
function stubDownload(impl: () => Promise<{ bytes: ArrayBuffer }>) {
  const downloadPreview = vi.fn(impl)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        downloadPreview,
        resolve: vi.fn(resolvePreviewResource),
        affordances: vi.fn(async () => activeAffordances),
      },
    },
  })
  return downloadPreview
}

// Preview + the per-resource re-check primitive (`gfs.resolve`) the focus
// revalidation calls. `resolve` rejects to model an unshared resource.
function stubGfs(opts: {
  downloadPreview: () => Promise<{ bytes: ArrayBuffer }>
  resolve: (uri: string) => Promise<unknown>
}) {
  const downloadPreview = vi.fn(opts.downloadPreview)
  const resolve = vi.fn(opts.resolve)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        downloadPreview,
        resolve,
        affordances: vi.fn(async () => activeAffordances),
      },
    },
  })
  return { downloadPreview, resolve }
}

function openPreviewActions(fileName: string) {
  const heading = screen.getByRole('heading', { name: fileName, level: 2 })
  const titleRow = heading.closest('.da-gfs-preview-title-row')
  if (!titleRow) throw new Error(`Preview title actions are unavailable for ${fileName}`)
  fireEvent.click(
    within(titleRow as HTMLElement).getByRole('button', { name: `Options for ${fileName}` })
  )
  return screen.getByRole('menu', { name: `Actions for ${fileName}` })
}

function clickPreviewAction(fileName: string, actionName: string) {
  const menu = openPreviewActions(fileName)
  if (actionName === 'Copy link' || actionName === 'Copy file ID') {
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Share$/ }))
    const shareMenu = screen.getByRole('menu', { name: `Share options for ${fileName}` })
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: actionName }))
    return
  }
  fireEvent.click(within(menu).getByRole('menuitem', { name: actionName }))
}

describe('FilePreviewPage', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    for (const queryClient of queryClients.splice(0)) queryClient.clear()
    vi.restoreAllMocks()
  })

  it('mounts the image body for an image preview tab', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))

    render(
      <FilePreviewPage
        gfsUri="gfs://main/image-1"
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
        onOpenRoute={() => undefined}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    // The preview page title is a page-level h2 (not a dialog h3).
    const title = screen.getByRole('heading', { name: 'diagram.png', level: 2 })
    expect(title).toBeTruthy()
    const titleRow = title.closest('.da-gfs-preview-title-row')
    expect(titleRow).toBeTruthy()
    fireEvent.click(
      within(titleRow as HTMLElement).getByRole('button', { name: 'Options for diagram.png' })
    )
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Share',
      'Rename',
      'Move to',
      'Copy content',
      'Download',
      'Delete',
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    const menu = screen.getByRole('menu', { name: 'Actions for diagram.png' })
    expect(within(menu).queryByRole('menuitem', { name: 'Refresh' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'Open file from ID' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Copy content' })).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Share$/ }))
    const shareMenu = screen.getByRole('menu', { name: 'Share options for diagram.png' })
    expect(within(shareMenu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    expect(within(shareMenu).getByRole('menuitem', { name: 'Copy file ID' })).toBeTruthy()
  })

  it('keeps file actions beside the filename and restores the navbar controls', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const titlebarLeadingRoot = document.createElement('div')
    document.body.appendChild(titlebarLeadingRoot)

    const view = render(
      <FilePreviewPage
        gfsUri="gfs://main/image-1"
        fileName="diagram.png"
        fileKind="image"
        byteLength={3}
        titlebarLeadingTarget={titlebarLeadingRoot}
        onOpenRoute={() => undefined}
      />
    )

    try {
      expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
      await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
      const toolbar = within(titlebarLeadingRoot).getByRole('toolbar', {
        name: 'EvenDrive actions',
      })
      expect(within(toolbar).getByRole('button', { name: 'Refresh' })).toBeTruthy()
      expect(within(toolbar).getByRole('button', { name: 'Copy link' })).toBeTruthy()
      expect(within(toolbar).getByRole('button', { name: 'Open link' })).toBeTruthy()
      const menu = openPreviewActions('diagram.png')
      fireEvent.click(within(menu).getByRole('menuitem', { name: /^Share$/ }))
      expect(
        within(screen.getByRole('menu', { name: 'Share options for diagram.png' })).getByRole(
          'menuitem',
          { name: 'Copy link' }
        )
      ).toBeTruthy()
    } finally {
      view.unmount()
      titlebarLeadingRoot.remove()
    }
  })

  it('dispatches only one preview rename for repeated Save submission', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const renameResource = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('409 stale resource version'))
      .mockResolvedValue(undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(async () =>
            resolveResource({
              resourceId: '0123456789abcdef0123456789abcdef',
              rid: '0123456789abcdef0123456789abcdef',
              gfsUri: uri,
              drive: 'main',
              parentResourceId: 'preview-parent',
              name: 'diagram.png',
              kind: 'file',
              version: 7,
              bytes: 1,
            })
          ),
          affordances: vi.fn(async () => activeAffordances),
          renameResource,
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Rename')
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'renamed.png' },
    })

    act(() => {
      fireEvent.submit(dialog)
      fireEvent.submit(dialog)
    })

    await waitFor(() => expect(renameResource).toHaveBeenCalled())
    expect(renameResource).toHaveBeenCalledTimes(1)
    expect(renameResource).toHaveBeenCalledWith(
      '0123456789abcdef0123456789abcdef',
      'renamed.png',
      'main',
      7
    )
    expect(screen.getByRole('dialog', { name: 'Rename file' })).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'renamed-again.png' },
    })
    fireEvent.submit(dialog)
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(2))
    expect(renameResource).toHaveBeenLastCalledWith(
      '0123456789abcdef0123456789abcdef',
      'renamed-again.png',
      'main',
      7
    )
  })

  it('releases and fences pending rename work across a generation change', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const renameResolvers: Array<() => void> = []
    const renameResource = vi.fn(
      () =>
        new Promise<void>(resolve => {
          renameResolvers.push(resolve)
        })
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(async () =>
            resolveResource({
              resourceId: '0123456789abcdef0123456789abcdef',
              rid: '0123456789abcdef0123456789abcdef',
              gfsUri: uri,
              drive: 'main',
              parentResourceId: 'preview-parent',
              name: 'diagram.png',
              kind: 'file',
              version: 7,
              bytes: 1,
            })
          ),
          affordances: vi.fn(async () => activeAffordances),
          renameResource,
        },
      },
    })
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const props = {
      gfsUri: uri,
      fileName: 'diagram.png',
      fileKind: 'image',
      mimeType: 'image/png',
      byteLength: 1,
    } as const
    const view = render(<FilePreviewPage {...props} />)

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Rename')
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
    const submit = () =>
      within(screen.getByRole('dialog', { name: 'Rename file' })).getByRole('button', {
        name: 'Save',
      }) as HTMLButtonElement
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'renamed.png' },
    })
    fireEvent.submit(dialog)
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(1))
    expect(submit().disabled).toBe(true)

    controllerState.sessionGeneration = 2
    view.rerender(<FilePreviewPage {...props} />)
    await waitFor(() => expect(submit().disabled).toBe(false))
    fireEvent.change(
      within(screen.getByRole('dialog', { name: 'Rename file' })).getByLabelText('New name'),
      {
        target: { value: 'renamed-again.png' },
      }
    )
    fireEvent.click(submit())
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(2))
    expect(submit().disabled).toBe(true)
    await act(async () => renameResolvers[0]!())
    expect(submit().disabled).toBe(true)
    await act(async () => renameResolvers[1]!())
  })

  it('does not report a rename committed when generation changes during invalidation', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let resolveInvalidation!: (value: unknown) => void
    const invalidationRead = new Promise<unknown>(resolve => {
      resolveInvalidation = resolve
    })
    let resolveCount = 0
    const resolve = vi.fn(async () => {
      resolveCount += 1
      if (resolveCount === 2) return invalidationRead
      return resolveResource({
        resourceId: '0123456789abcdef0123456789abcdef',
        rid: '0123456789abcdef0123456789abcdef',
        gfsUri: uri,
        drive: 'main',
        parentResourceId: 'preview-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    })
    const renameResource = vi.fn(async () => undefined)
    const onRenameCommitted = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve,
          affordances: vi.fn(async () => activeAffordances),
          renameResource,
        },
      },
    })
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const props = {
      gfsUri: uri,
      fileName: 'diagram.png',
      fileKind: 'image',
      mimeType: 'image/png',
      byteLength: 1,
      onRenameCommitted,
    } as const
    const view = render(<FilePreviewPage {...props} />)
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Rename')
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'renamed.png' },
    })
    fireEvent.submit(dialog)
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

    controllerState.sessionGeneration = 2
    view.rerender(<FilePreviewPage {...props} />)
    await act(async () => resolveInvalidation(await resolvePreviewResource(uri)))
    expect(onRenameCommitted).not.toHaveBeenCalled()
  })

  it('does not refetch old grant authority after a generation change during revoke', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let resolveRevoke!: () => void
    const revokePending = new Promise<void>(resolve => {
      resolveRevoke = resolve
    })
    const revokeGrant = vi.fn(() => revokePending)
    const listGrants = vi.fn(async () => [
      {
        id: 'preview-grant-1',
        drive: 'main',
        resourceId: '0123456789abcdef0123456789abcdef',
        subject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
        permissions: ['read'],
        inherit: false,
      },
    ])
    const producerResource = () =>
      resolveResource({
        resourceId: '0123456789abcdef0123456789abcdef',
        rid: '0123456789abcdef0123456789abcdef',
        gfsUri: uri,
        drive: 'main',
        parentResourceId: null,
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: {
          listMine: vi.fn(async () => [
            {
              name: 'chatllm',
              contextRef: 'ctx-1',
              mcpServers: [],
              gfsSubject: { type: 'host', id: '1st:mcp-host/chatllm' },
            },
          ]),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(producerResource),
          affordances: vi.fn(async () => activeAffordances),
          listGrants,
          listShares: vi.fn(async () => []),
          listResourceAcl: vi.fn(async () => []),
          revokeGrant,
        },
      },
    })
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const view = render(
      <FilePreviewPage gfsUri={uri} fileName="diagram.png" fileKind="image" byteLength={1} />
    )
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Share')
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Share options for diagram.png' })).getByRole(
        'menuitem',
        { name: 'Share' }
      )
    )
    await screen.findByRole('dialog', { name: 'Share file diagram.png' })
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('preview-grant-1'))

    controllerState.sessionGeneration = 2
    view.rerender(
      <FilePreviewPage gfsUri={uri} fileName="diagram.png" fileKind="image" byteLength={1} />
    )
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(2))
    await act(async () => resolveRevoke())
    expect(listGrants).toHaveBeenCalledTimes(2)
  })

  it('does not refetch old share authority after a generation change during revoke', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let resolveRevoke!: () => void
    const revokePending = new Promise<void>(resolve => {
      resolveRevoke = resolve
    })
    const revokeShare = vi.fn(() => revokePending)
    const listShares = vi.fn(async () => [
      {
        id: 'preview-share-1',
        drive: 'main',
        resourceId: '0123456789abcdef0123456789abcdef',
        subject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
        permissions: ['read'],
        includeDescendants: true,
      },
    ])
    const producerResource = () =>
      resolveResource({
        resourceId: '0123456789abcdef0123456789abcdef',
        rid: '0123456789abcdef0123456789abcdef',
        gfsUri: uri,
        drive: 'main',
        parentResourceId: null,
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: {
          listMine: vi.fn(async () => [
            {
              name: 'chatllm',
              contextRef: 'ctx-1',
              mcpServers: [],
              gfsSubject: { type: 'host', id: '1st:mcp-host/chatllm' },
            },
          ]),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(producerResource),
          affordances: vi.fn(async () => activeAffordances),
          listGrants: vi.fn(async () => []),
          listShares,
          listResourceAcl: vi.fn(async () => []),
          revokeShare,
        },
      },
    })
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const view = render(
      <FilePreviewPage gfsUri={uri} fileName="diagram.png" fileKind="image" byteLength={1} />
    )
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Share')
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Share options for diagram.png' })).getByRole(
        'menuitem',
        { name: 'Share' }
      )
    )
    await screen.findByRole('dialog', { name: 'Share file diagram.png' })
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('preview-share-1'))

    controllerState.sessionGeneration = 2
    view.rerender(
      <FilePreviewPage gfsUri={uri} fileName="diagram.png" fileKind="image" byteLength={1} />
    )
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(2))
    await act(async () => resolveRevoke())
    expect(listShares).toHaveBeenCalledTimes(2)
  })

  it('does not let a rename digest started in the old generation adopt new authority', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
    let digestCompleted!: () => void
    let releaseDigest!: (value: ArrayBuffer) => void
    const digestFinished = new Promise<void>(resolve => {
      digestCompleted = resolve
    })
    const digestResult = new Promise<ArrayBuffer>(resolve => {
      releaseDigest = resolve
    })
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(async (algorithm, data) => {
        const actualDigest = await nativeDigest(algorithm, data)
        digestCompleted()
        return digestResult.then(() => actualDigest)
      })
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async () => activeAffordances)
    const producerResource = () =>
      resolveResource({
        resourceId: '0123456789abcdef0123456789abcdef',
        rid: '0123456789abcdef0123456789abcdef',
        gfsUri: uri,
        drive: 'main',
        parentResourceId: 'preview-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(producerResource),
          affordances,
          renameResource,
        },
      },
    })
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const props = {
      gfsUri: uri,
      fileName: 'diagram.png',
      fileKind: 'image',
      byteLength: 1,
    } as const
    const view = render(<FilePreviewPage {...props} />)

    try {
      expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
      await waitFor(() => expect(affordances).toHaveBeenCalled())
      clickPreviewAction('diagram.png', 'Rename')
      const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
      fireEvent.change(within(dialog).getByLabelText('New name'), {
        target: { value: 'a'.repeat(260) + '.txt' },
      })
      fireEvent.submit(dialog)
      await digestFinished
      const permissionReadsBeforeReplacement = affordances.mock.calls.length

      controllerState.sessionGeneration = 2
      view.rerender(<FilePreviewPage {...props} />)
      await act(async () => releaseDigest(new ArrayBuffer(0)))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(renameResource).not.toHaveBeenCalled()
      expect(affordances.mock.calls.length).toBe(permissionReadsBeforeReplacement)
    } finally {
      releaseDigest(new ArrayBuffer(0))
      digestSpy.mockRestore()
      view.unmount()
    }
  })

  it('keeps the preview delete confirmation busy and non-dismissible until settlement', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let resolveDelete!: () => void
    const deletePromise = new Promise<void>(resolve => {
      resolveDelete = resolve
    })
    const deleteResource = vi.fn(() => deletePromise)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(async () =>
            resolveResource({
              resourceId: '0123456789abcdef0123456789abcdef',
              rid: '0123456789abcdef0123456789abcdef',
              gfsUri: uri,
              drive: 'main',
              parentResourceId: 'preview-parent',
              name: 'diagram.png',
              kind: 'file',
              version: 7,
              bytes: 1,
            })
          ),
          affordances: vi.fn(async () => activeAffordances),
          deleteResource,
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Delete')
    const dialog = await screen.findByRole('dialog', { name: 'Delete diagram.png?' })
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    const confirm = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    const cancelFocus = vi.spyOn(cancel, 'focus')
    await waitFor(() => expect(document.activeElement).toBe(cancel))

    fireEvent.click(confirm)

    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBe('true'))
    expect(cancelFocus).not.toHaveBeenCalled()
    expect(cancel.disabled).toBe(true)
    expect(confirm.disabled).toBe(true)
    expect(deleteResource).toHaveBeenCalledTimes(1)
    expect(deleteResource).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef', 'main', 7)

    fireEvent.keyDown(window, { key: 'Escape' })
    const backdrop = dialog.parentElement
    expect(backdrop).toBeTruthy()
    fireEvent.mouseDown(backdrop as HTMLElement)
    fireEvent.click(cancel)
    expect(screen.getByRole('dialog', { name: 'Delete diagram.png?' })).toBeTruthy()
    expect(deleteResource).toHaveBeenCalledTimes(1)

    await act(async () => resolveDelete())
    expect(await screen.findByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Delete diagram.png?' })).toBeNull()
    expect(pushToast).toHaveBeenCalledWith('Deleted diagram.png', 'success')
  })

  it('does not dispatch delete after its captured permission preflight loses authority', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let resolvePermission!: (value: typeof activeAffordances) => void
    let permissionStarted!: () => void
    const permissionPending = new Promise<typeof activeAffordances>(resolve => {
      resolvePermission = resolve
    })
    const permissionStartedPromise = new Promise<void>(resolve => {
      permissionStarted = resolve
    })
    let holdNextPermission = false
    const affordances = vi.fn(async () => {
      if (holdNextPermission) {
        holdNextPermission = false
        permissionStarted()
        return permissionPending
      }
      return activeAffordances
    })
    const deleteResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(async () =>
            resolveResource({
              resourceId: '0123456789abcdef0123456789abcdef',
              rid: '0123456789abcdef0123456789abcdef',
              gfsUri: uri,
              drive: 'main',
              parentResourceId: 'preview-parent',
              name: 'diagram.png',
              kind: 'file',
              version: 7,
              bytes: 1,
            })
          ),
          affordances,
          deleteResource,
        },
      },
    })
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const props = {
      gfsUri: uri,
      fileName: 'diagram.png',
      fileKind: 'image',
      byteLength: 1,
    } as const
    const view = render(<FilePreviewPage {...props} />)
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Delete')
    const dialog = await screen.findByRole('dialog', { name: 'Delete diagram.png?' })
    const now = Date.now()
    const advanceAuthorityAge = vi.spyOn(Date, 'now').mockReturnValue(now + 16_000)
    holdNextPermission = true
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await permissionStartedPromise
    expect(deleteResource).not.toHaveBeenCalled()

    controllerState.sessionGeneration = 2
    view.rerender(<FilePreviewPage {...props} />)
    expect(deleteResource).not.toHaveBeenCalled()
    await act(async () => resolvePermission(activeAffordances))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(deleteResource).not.toHaveBeenCalled()
    advanceAuthorityAge.mockRestore()
  })

  it('re-enables preview delete confirmation after a failed request', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let rejectDelete!: (error: Error) => void
    const deletePromise = new Promise<void>((_resolve, reject) => {
      rejectDelete = reject
    })
    const deleteResource = vi.fn(() => deletePromise)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          resolve: vi.fn(async () =>
            resolveResource({
              resourceId: '0123456789abcdef0123456789abcdef',
              rid: '0123456789abcdef0123456789abcdef',
              gfsUri: uri,
              drive: 'main',
              parentResourceId: 'preview-parent',
              name: 'diagram.png',
              kind: 'file',
              version: 7,
              bytes: 1,
            })
          ),
          affordances: vi.fn(async () => activeAffordances),
          deleteResource,
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    clickPreviewAction('diagram.png', 'Delete')
    const dialog = await screen.findByRole('dialog', { name: 'Delete diagram.png?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement

    fireEvent.click(confirm)
    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBe('true'))
    await act(async () => rejectDelete(new Error('409 conflict')))

    await waitFor(() => expect(confirm.disabled).toBe(false))
    expect(screen.getByRole('dialog', { name: 'Delete diagram.png?' })).toBeTruthy()
    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining('Could not delete the file:'),
      'error'
    )
  })

  it('mounts the markdown body for a markdown preview tab', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new TextEncoder().encode('# Hi').buffer }))

    render(
      <FilePreviewPage
        gfsUri="gfs://main/md-1"
        fileName="README.md"
        fileKind="markdown"
        byteLength={4}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Hi', level: 1 })).toBeTruthy()
  })

  it('mounts the video body for a video preview tab', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))

    render(
      <FilePreviewPage
        gfsUri="gfs://main/video-1"
        fileName="demo.mp4"
        fileKind="video"
        mimeType="video/mp4"
        byteLength={3}
        onOpenRoute={() => undefined}
      />
    )

    expect(await screen.findByLabelText('Video preview of demo.mp4')).toBeTruthy()
    await waitFor(() => expect(window.clerum.gfs.affordances).toHaveBeenCalled())
    const menu = openPreviewActions('demo.mp4')
    expect(within(menu).queryByRole('menuitem', { name: 'Copy content' })).toBeNull()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Share', 'Rename', 'Move to', 'Download', 'Delete'])
  })

  it('uses the shareable link, canonical ID, and preview copy semantics from the filename menu', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const markdown = '# Hello\n\nText to copy.'
    const copyDeepLink = vi.fn(async () => ({
      url: buildGfsResourceWebLink('https://profile.example', uri),
    }))
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          copyDeepLink,
          downloadPreview: vi.fn(async () => ({
            bytes: new TextEncoder().encode(markdown).buffer,
          })),
          resolve: vi.fn(resolvePreviewResource),
          affordances: vi.fn(async () => activeAffordances),
        },
      },
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="Résumé # ? %.md"
        fileKind="markdown"
        byteLength={markdown.length}
      />
    )

    await screen.findByRole('heading', { name: 'Hello' })
    clickPreviewAction('Résumé # ? %.md', 'Copy link')
    clickPreviewAction('Résumé # ? %.md', 'Copy file ID')
    const menu = openPreviewActions('Résumé # ? %.md')
    const copyContent = within(menu).getByRole('menuitem', { name: 'Copy content' })
    await waitFor(() => expect((copyContent as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copyContent)

    await waitFor(() => expect(copyDeepLink).toHaveBeenCalledWith(uri))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(uri))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
  })

  it('copies the loaded image bytes through the filename menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubGfs({
      downloadPreview: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }),
      resolve: async () => ({ kind: 'file' }),
    })

    render(
      <FilePreviewPage
        gfsUri="gfs://main/image-1"
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    const menu = openPreviewActions('diagram.png')
    const copyContent = within(menu).getByRole('menuitem', { name: 'Copy content' })
    await waitFor(() => expect((copyContent as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copyContent)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('data:image/png;base64,AQID'))
  })

  it('restores keyboard focus to the Preview menu trigger after copying content', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubGfs({
      downloadPreview: async () => ({
        bytes: new TextEncoder().encode('# Keyboard copy').buffer,
      }),
      resolve: async () => ({ kind: 'file' }),
    })

    render(
      <FilePreviewPage
        gfsUri="gfs://main/0123456789abcdef0123456789abcdef"
        fileName="keyboard.md"
        fileKind="markdown"
        byteLength={15}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Keyboard copy' })).toBeTruthy()
    const trigger = screen.getByRole('button', { name: 'Options for keyboard.md' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = screen.getByRole('menu', { name: 'Actions for keyboard.md' })
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: 'Copy content' })
    )
    await user.keyboard('{Enter}')

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Keyboard copy'))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.queryByRole('menu', { name: 'Actions for keyboard.md' })).toBeNull()
  })

  it('runs a pending sidebar copy once, only after its exact preview is ready', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const otherUri = 'gfs://main/fedcba9876543210fedcba9876543210'
    const markdown = '# Exact target\n\nCopy this body.'
    const writeText = vi.fn(async () => undefined)
    const onHandled = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubGfs({
      downloadPreview: async () => ({ bytes: new TextEncoder().encode(markdown).buffer }),
      resolve: async () => ({ kind: 'file' }),
    })

    const renderPreview = (gfsUri: string) => (
      <FilePreviewPage
        gfsUri={gfsUri}
        fileName="report.md"
        fileKind="markdown"
        byteLength={markdown.length}
        pendingResourceAction={{ id: 44, targetUri: uri, actionId: 'copy-content' }}
        onPendingResourceActionHandled={onHandled}
      />
    )
    const view = render(renderPreview(otherUri))

    expect(await screen.findByRole('heading', { name: 'Exact target' })).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
    expect(onHandled).not.toHaveBeenCalled()

    view.rerender(renderPreview(uri))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(onHandled).toHaveBeenCalledTimes(1)
    expect(onHandled).toHaveBeenCalledWith(44)
  })

  it('refreshes by revalidating and reloading the exact preview resource', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let downloadNumber = 0
    const { downloadPreview, resolve } = stubGfs({
      downloadPreview: async () => ({
        bytes: new TextEncoder().encode(`# Load ${++downloadNumber}`).buffer,
      }),
      resolve: async () => ({ kind: 'file' }),
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    const titlebarLeadingRoot = document.createElement('div')
    document.body.appendChild(titlebarLeadingRoot)
    const view = render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="report.md"
        fileKind="markdown"
        byteLength={7}
        titlebarLeadingTarget={titlebarLeadingRoot}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Load 1' })).toBeTruthy()
    fireEvent.click(within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(uri))
    expect(await screen.findByRole('heading', { name: 'Load 2' })).toBeTruthy()
    expect(downloadPreview).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { name: 'report.md', level: 2 })).toBeTruthy()
    view.unmount()
    titlebarLeadingRoot.remove()
  })

  it('releases and fences pending refresh work when the published generation changes', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const refreshResolvers: Array<(value: unknown) => void> = []
    const resolve = vi.fn(async () =>
      resolveResource({
        resourceId: '0123456789abcdef0123456789abcdef',
        rid: '0123456789abcdef0123456789abcdef',
        gfsUri: uri,
        drive: 'main',
        parentResourceId: 'preview-parent',
        name: 'report.md',
        kind: 'file',
        version: 1,
        bytes: 3,
      })
    )
    const originalResolve = resolve.getMockImplementation()!
    resolve.mockImplementationOnce(() => originalResolve())
    const refreshResolve = vi.fn(
      () =>
        new Promise<unknown>(resolve => {
          refreshResolvers.push(resolve)
        })
    )
    let resolveCount = 0
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({
            bytes: new TextEncoder().encode('# Preview').buffer,
          })),
          resolve: vi.fn(() => (refreshPending ? refreshResolve() : resolve())),
          affordances: vi.fn(async () => activeAffordances),
        },
      },
    })
    let refreshPending = false
    const controllerState = controller()
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const titlebarLeadingRoot = document.createElement('div')
    document.body.appendChild(titlebarLeadingRoot)
    const view = render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="report.md"
        fileKind="markdown"
        byteLength={3}
        titlebarLeadingTarget={titlebarLeadingRoot}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Preview' })).toBeTruthy()
    refreshPending = true
    fireEvent.click(within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(refreshResolve).toHaveBeenCalledTimes(1))
    expect(
      (within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    controllerState.sessionGeneration = 2
    refreshPending = false
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    view.rerender(
      <FilePreviewPage
        gfsUri={uri}
        fileName="report.md"
        fileKind="markdown"
        byteLength={3}
        titlebarLeadingTarget={titlebarLeadingRoot}
      />
    )
    await waitFor(() =>
      expect(
        (within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    )
    refreshPending = true
    fireEvent.click(within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(refreshResolve).toHaveBeenCalledTimes(2))
    expect(
      (within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await act(async () => {
      refreshResolvers[0]!(await resolvePreviewResource(uri))
    })
    expect(
      (within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await act(async () => refreshResolvers[1]!(await resolvePreviewResource(uri)))
    expect(
      (within(titlebarLeadingRoot).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
    view.unmount()
    titlebarLeadingRoot.remove()
  })

  it('omits Refresh while the preview is unavailable', () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    const titlebarLeadingRoot = document.createElement('div')
    document.body.appendChild(titlebarLeadingRoot)
    const view = render(
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        byteLength={3}
        unavailable
        titlebarLeadingTarget={titlebarLeadingRoot}
      />
    )

    expect(within(titlebarLeadingRoot).queryByRole('button', { name: 'Refresh' })).toBeNull()
    view.unmount()
    titlebarLeadingRoot.remove()
  })

  it('keeps the canonical file ID action available without exposing an unavailable filename', () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="secret.png"
        fileKind="image"
        byteLength={1}
        unavailable
      />
    )

    expect(screen.getByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByText('secret.png')).toBeNull()
    expect(screen.getByRole('button', { name: 'Options for unavailable file' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Options for unavailable file' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file ID' }))

    expect(writeText).toHaveBeenCalledWith(uri)
  })

  // R-4 (spec 18 §3.B.5): the preview tab must NOT close when access is revoked;
  // stale bytes are purged and replaced by a non-sensitive unavailable shell.
  it('purges the open preview when authority reports a revoked resource', async () => {
    const downloadPreview = stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const controllerState = controller('active')
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)

    // A fresh element per render pass so the authority update is observed.
    const makeElement = () => (
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )
    const { rerender } = render(makeElement())

    // First fetch succeeds and the image renders.
    expect(await screen.findByAltText('Preview of secret.png')).toBeTruthy()
    expect(downloadPreview).toHaveBeenCalledTimes(1)

    // Access is revoked out-of-band → the authority controller reports revoked.
    controllerState.accessState = 'revoked'
    rerender(makeElement())

    // The tab stays mounted, but sensitive preview bytes, filename, and denial
    // details are removed when authorization is no longer available.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(await screen.findByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByText('403 Forbidden')).toBeNull()
    expect(screen.queryByText('secret.png')).toBeNull()
    expect(downloadPreview).toHaveBeenCalledTimes(1)
  })

  it('purges image bytes and its object URL on session expiry through the entity registry', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const registry = new EntityChangeRegistry()

    function SessionAwarePreview() {
      const [unavailable, setUnavailable] = useState(false)
      useEffect(() => registry.subscribe(['gfs', 'authorization'], () => setUnavailable(true)), [])
      return (
        <FilePreviewPage
          gfsUri="gfs://main/session-expired"
          fileName="session-secret.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={3}
          unavailable={unavailable}
        />
      )
    }

    render(<SessionAwarePreview />)
    expect(await screen.findByAltText('Preview of session-secret.png')).toBeTruthy()

    act(() =>
      registry.dispatch({
        type: 'stream.closing',
        schemaVersion: 1,
        cursor: '00000000-0000-0000-0000-000000000001',
        reason: 'session_expired',
      })
    )

    expect(await screen.findByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByAltText('Preview of session-secret.png')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gfs-preview')
  })

  // R1-H6: a persistent preview tab outlives the grant that opened it. A
  // per-RESOURCE unshare (gfs.read now 403s for THIS file, session still valid)
  // must drop the rendered bytes and the Copy affordance on window focus WITHOUT
  // a tab switch/remount — otherwise the image stays on screen and Copy keeps
  // writing the PNG. This is distinct from the session-401 path (H2) above.
  it('drops the previewed bytes and Copy on focus when the resource is unshared (R1-H6)', async () => {
    // Producer-derived denial: the exact ApiError message resolve rejects with
    // for a per-resource 403 (T1 — not a hand-written string).
    const deniedMessage = await resolveDeniedMessage('gfs://main/secret')

    const controllerState = controller('active')
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    let resolveCount = 0
    const { resolve } = stubGfs({
      downloadPreview: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }),
      resolve: async () => {
        resolveCount += 1
        if (resolveCount === 1) return await resolvePreviewResource('gfs://main/secret')
        throw new Error(deniedMessage)
      },
    })

    render(
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )

    // The bytes load and Copy is enabled.
    expect(await screen.findByAltText('Preview of secret.png')).toBeTruthy()
    const menuBefore = openPreviewActions('secret.png')
    const copyBefore = within(menuBefore).getByRole('menuitem', { name: 'Copy content' })
    await waitFor(() => expect((copyBefore as HTMLButtonElement).disabled).toBe(false))

    // The file is unshared out-of-band → the next focus re-check 403s.
    fireEvent.focus(window)

    // The image, Copy affordance, filename, and denial details are gone; the
    // tab remains mounted behind a generic unavailable shell.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Options for secret.png' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy content' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByText(deniedMessage)).toBeNull()
    expect(screen.queryByText('secret.png')).toBeNull()
    expect(resolve).toHaveBeenCalledWith('gfs://main/secret')
    // A per-resource 403 is NOT a session-authority failure: it was routed
    // through handleAuthorityFailure (which declined) and did not revoke.
    expect(controllerState.handleAuthorityFailure).toHaveReturnedWith(false)
  })

  // H2 no-regress: a SESSION-authority failure discovered by the focus re-check
  // must route to the shared session revoke, NOT to the local per-resource
  // denied state (the two cases stay distinct).
  it('routes a session-authority failure on focus to the shared revoke, not local denial', async () => {
    const sessionMessage = await resolveDeniedMessage(
      'gfs://main/secret',
      { code: 'unauthorized', message: 'not authenticated' },
      401
    )

    // The controller classifies this as a session-authority failure (revokes).
    const controllerState = controller('active', () => true)
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    let resolveCount = 0
    stubGfs({
      downloadPreview: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }),
      resolve: async () => {
        resolveCount += 1
        if (resolveCount === 1) return await resolvePreviewResource('gfs://main/secret')
        throw new Error(sessionMessage)
      },
    })

    render(
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )

    expect(await screen.findByAltText('Preview of secret.png')).toBeTruthy()

    fireEvent.focus(window)

    await waitFor(() =>
      expect(controllerState.handleAuthorityFailure).toHaveBeenCalledWith(
        sessionMessage,
        'operation',
        'preview-test-user:main',
        1
      )
    )
    // The session path handled it; the local per-resource denial did NOT fire.
    expect(controllerState.handleAuthorityFailure).toHaveReturnedWith(true)
    expect(screen.queryByText('You no longer have access to this file')).toBeNull()
  })
})
