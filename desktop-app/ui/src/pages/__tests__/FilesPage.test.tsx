// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES } from '@constants/gfsFileUpload'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import type { Tone } from '@/uiTypes'
import { FilesPage } from '../FilesPage'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

function baseController() {
  return {
    current: null,
    crumbs: [],
    sessionScope: 'env-1:user-1:team-1',
    accessibleResources: [],
    items: [],
    affordances: null,
    affordancesError: null,
    loadingAffordances: false,
    rowAffordancesResourceId: null,
    setRowAffordancesResourceId: vi.fn(),
    rowAffordancesByResourceId: {},
    rowAffordances: null,
    rowAffordancesError: null,
    loadingAccessible: false,
    loading: false,
    accessibleError: null,
    accessibleNotice: null,
    error: null,
    openError: null,
    resolving: false,
    hasMoreAccessible: false,
    isFetchingMoreAccessible: false,
    hasMore: false,
    isFetchingMore: false,
    loadMoreAccessible: vi.fn(),
    loadMore: vi.fn(),
    openUri: vi.fn(),
    openResource: vi.fn(),
    openChild: vi.fn(),
    goToCrumb: vi.fn(),
    restoreCrumbs: vi.fn(),
    grant: vi.fn(),
    grants: [],
    grantsError: null,
    loadingGrants: false,
    refreshGrants: vi.fn(),
    inheritedAccess: [],
    loadingInheritedAccess: false,
    refreshInheritedAccess: vi.fn(),
    revokeGrant: vi.fn(),
    revoking: false,
    shares: [],
    sharesError: null,
    loadingShares: false,
    refreshShares: vi.fn(),
    revokeShare: vi.fn(),
    revokingShare: false,
    accessState: 'active',
    retryAccess: vi.fn(),
    handleAuthorityFailure: vi.fn(() => false),
    createShare: vi.fn(),
    createFolder: vi.fn(),
    createFile: vi.fn(),
    createFileFromPath: vi.fn(),
    replaceFile: vi.fn(),
    replaceFileFromPath: vi.fn(),
    renameResource: vi.fn(),
    moveResource: vi.fn(),
    deleteResource: vi.fn(),
    mutating: false,
    reset: vi.fn(),
    refreshAffordances: vi.fn(),
    discoveryFailure: null,
    retryDiscovery: vi.fn(),
    authorityPending: false,
    errorUpdatedAt: 0,
    retryChildren: vi.fn(),
  }
}

function renderFilesPage(
  pushToast?: (message: string, tone: Tone) => void,
  onOpenPreview?: (preview: unknown) => void
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <FilesPage pushToast={pushToast} onOpenPreview={onOpenPreview} />
    </QueryClientProvider>
  )
}

async function openManageDialog(resourceName: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Options for ${resourceName}` }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }))
  })
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('menu', { name: `Share options for ${resourceName}` })).getByRole(
        'menuitem',
        { name: 'Share' }
      )
    )
  })
}

async function chooseResourceAction(resourceName: string, actionName: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Options for ${resourceName}` }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: actionName }))
  })
}

describe('FilesPage', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          getPathForFile: vi.fn((file: File) => `/tmp/${file.name}`),
        },
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders unavailable automatic discovery as an info notice, not a technical error', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleNotice:
        'Automatic EvenDrive discovery is not available in this desktop runtime. You can still open any EvenDrive link you have.',
    })

    renderFilesPage()

    const notice = screen.getByText(/Automatic EvenDrive discovery is not available/i)
    expect(notice.closest('.status-banner')?.className).toContain('tone-info')
    expect(screen.queryByText(/window\.clerum/i)).toBeNull()
    expect(screen.queryByText(/listAccessible is not a function/i)).toBeNull()
    expect(screen.getByText('No shared files yet')).toBeTruthy()
  })

  it('renders no assigned GFS resources as an empty state without an error banner', () => {
    hookMock.useGfsBrowserController.mockReturnValue(baseController())

    renderFilesPage()

    expect(screen.getByText('No shared files yet')).toBeTruthy()
    expect(
      screen.getByText('Resources shared directly with you or your teams will appear here.')
    ).toBeTruthy()
    expect(screen.queryByText(/Automatic EvenDrive discovery is not available/i)).toBeNull()
    expect(screen.queryByText(/Error invoking remote method/i)).toBeNull()
  })

  it.each([
    ['initial GFS discovery', { loadingAccessible: true }],
    [
      'folder navigation',
      {
        current: {
          resourceId: 'folder-loading',
          gfsUri: 'gfs://main/folder-loading',
          name: 'Loading folder',
          kind: 'directory' as const,
          version: 1,
        },
        loading: true,
      },
    ],
  ])('shows a subtle borderless loader during %s', (_scenario, state) => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      ...state,
    })

    renderFilesPage()

    const loader = screen.getByRole('status', { name: 'Loading files' })
    expect(loader.classList.contains('da-gfs-loading')).toBe(true)
    expect(loader.querySelectorAll('.da-gfs-loading__dot')).toHaveLength(3)
    expect(screen.queryByText('Fetching your Global File System resources…')).toBeNull()
    expect(loader.closest('.empty-state')).toBeNull()
  })

  it('opens a shared folder from the single browser workspace', async () => {
    const openResource = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      openResource,
      accessibleResources: [
        {
          resourceId: 'folder-1',
          rid: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          drive: 'main',
          parentResourceId: null,
          name: 'Product',
          kind: 'directory',
          path: '/Product',
          version: 1,
          bytes: 0,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: true,
        },
      ],
    })

    renderFilesPage()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Product' }))
    })

    expect(openResource).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'folder-1' }))
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('shows share and rename row actions when the resource permissions allow them', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: null,
          name: 'report.txt',
          kind: 'file',
          path: '/report.txt',
          version: 1,
          bytes: 12,
          permissions: ['read', 'write', 'manage_acl'],
        },
      ],
    })

    renderFilesPage()

    const row = screen
      .getByRole('button', { name: 'Open report.txt' })
      .closest<HTMLElement>('.da-grid__row')
    expect(row).not.toBeNull()
    expect(within(row!).getByRole('button', { name: 'Share report.txt' })).toBeTruthy()
    expect(within(row!).getByRole('button', { name: 'Download report.txt' })).toBeTruthy()
    expect(within(row!).getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    expect(
      Array.from(row!.querySelectorAll('.da-gfs-list__actions button')).map(button =>
        button.getAttribute('aria-label')
      )
    ).toEqual([
      'Share report.txt',
      'Download report.txt',
      'Rename report.txt',
      'Options for report.txt',
    ])
  })

  it('shows permission-backed share and rename actions for folder and file children', () => {
    const folder = {
      resourceId: 'folder-child',
      rid: 'folder-child',
      gfsUri: 'gfs://main/folder-child',
      drive: 'main',
      parentResourceId: 'parent-1',
      name: 'Assets',
      kind: 'directory' as const,
      path: '/Workspace/Assets',
      version: 2,
      bytes: 0,
    }
    const file = {
      resourceId: 'file-child',
      rid: 'file-child',
      gfsUri: 'gfs://main/file-child',
      drive: 'main',
      parentResourceId: 'parent-1',
      name: 'report.txt',
      kind: 'file' as const,
      path: '/Workspace/report.txt',
      version: 3,
      bytes: 12,
    }
    const readonlyFile = {
      ...file,
      resourceId: 'readonly-child',
      rid: 'readonly-child',
      gfsUri: 'gfs://main/readonly-child',
      name: 'readonly.txt',
    }
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      items: [folder, file, readonlyFile],
      rowAffordancesByResourceId: {
        'folder-child': {
          held: ['read', 'write', 'manage_acl'],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        },
        'file-child': {
          held: ['read', 'write', 'manage_acl'],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        },
        'readonly-child': {
          held: ['read'],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        },
      },
    })

    renderFilesPage()

    const folderRow = screen
      .getByRole('button', { name: 'Open Assets' })
      .closest<HTMLElement>('.da-grid__row')
    const fileRow = screen
      .getByRole('button', { name: 'Open report.txt' })
      .closest<HTMLElement>('.da-grid__row')
    const readonlyRow = screen
      .getByRole('button', { name: 'Open readonly.txt' })
      .closest<HTMLElement>('.da-grid__row')
    expect(folderRow).not.toBeNull()
    expect(fileRow).not.toBeNull()
    expect(readonlyRow).not.toBeNull()

    expect(within(folderRow!).getByRole('button', { name: 'Share Assets' })).toBeTruthy()
    expect(within(folderRow!).getByRole('button', { name: 'Rename Assets' })).toBeTruthy()
    expect(within(folderRow!).queryByRole('button', { name: 'Download Assets' })).toBeNull()

    expect(within(fileRow!).getByRole('button', { name: 'Share report.txt' })).toBeTruthy()
    expect(within(fileRow!).getByRole('button', { name: 'Download report.txt' })).toBeTruthy()
    expect(within(fileRow!).getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()

    expect(within(readonlyRow!).queryByRole('button', { name: 'Share readonly.txt' })).toBeNull()
    expect(within(readonlyRow!).queryByRole('button', { name: 'Rename readonly.txt' })).toBeNull()
  })

  it('orders directories before files, both alphabetically by name', async () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'file-z',
          rid: 'file-z',
          gfsUri: 'gfs://main/file-z',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'Zebra.md',
          kind: 'file',
          path: '/Zebra.md',
          version: 1,
          bytes: 12,
        },
        {
          resourceId: 'dir-b',
          rid: 'dir-b',
          gfsUri: 'gfs://main/dir-b',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'beta',
          kind: 'directory',
          path: '/beta',
          version: 1,
          bytes: 0,
        },
        {
          resourceId: 'file-a',
          rid: 'file-a',
          gfsUri: 'gfs://main/file-a',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'apple.md',
          kind: 'file',
          path: '/apple.md',
          version: 1,
          bytes: 4,
        },
        {
          resourceId: 'dir-a',
          rid: 'dir-a',
          gfsUri: 'gfs://main/dir-a',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'alpha',
          kind: 'directory',
          path: '/alpha',
          version: 1,
          bytes: 0,
        },
      ],
    })

    renderFilesPage()

    const resourceNamesInOrder = Array.from(document.querySelectorAll('.da-gfs-list__name')).map(
      node => node.textContent?.trim() ?? ''
    )
    expect(resourceNamesInOrder).toEqual(['alpha', 'beta', 'apple.md', 'Zebra.md'])

    const alphaRow = screen.getByRole('button', { name: 'alpha' }).closest('.da-grid__row')
    expect(alphaRow?.querySelector('.da-gfs-list__icon svg path')?.getAttribute('d')).toContain(
      'M464 128H272l-64-64H48C21.49 64 0 85.49 0 112v288'
    )
  })

  it('marks unreadable rows and refuses to open them instead of failing with a download 403', async () => {
    const openChild = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      openChild,
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'file-locked',
          rid: 'file-locked',
          gfsUri: 'gfs://main/file-locked',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'locked.txt',
          kind: 'file',
          path: '/locked.txt',
          version: 1,
          bytes: 8,
          readable: false,
        },
        {
          resourceId: 'dir-locked',
          rid: 'dir-locked',
          gfsUri: 'gfs://main/dir-locked',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'sealed',
          kind: 'directory',
          path: '/sealed',
          version: 1,
          bytes: 0,
          readable: false,
        },
        {
          resourceId: 'file-open',
          rid: 'file-open',
          gfsUri: 'gfs://main/file-open',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'open.md',
          kind: 'file',
          path: '/open.md',
          version: 1,
          bytes: 4,
          readable: true,
        },
      ],
    })

    const pushToast = vi.fn()
    renderFilesPage(pushToast)

    // Only the unreadable rows carry the badge and the no-access label.
    expect(screen.getAllByText('No access')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'locked.txt (no read access)' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'open.md (no read access)' })).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'locked.txt' }))
    })

    expect(pushToast).toHaveBeenCalledWith('You do not have read access to locked.txt', 'error')
    // The unreadable directory row also never navigates into the folder.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'sealed' }))
    })
    expect(pushToast).toHaveBeenCalledTimes(2)
    expect(openChild).not.toHaveBeenCalled()
  })

  it('omits Preview and Download from the ⋯ menu of an unreadable file (R1-H1)', async () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'file-locked',
          rid: 'file-locked',
          gfsUri: 'gfs://main/file-locked',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'locked.md',
          kind: 'file',
          path: '/locked.md',
          version: 1,
          bytes: 8,
          readable: false,
        },
        {
          resourceId: 'file-open',
          rid: 'file-open',
          gfsUri: 'gfs://main/file-open',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'open.md',
          kind: 'file',
          path: '/open.md',
          version: 1,
          bytes: 4,
          readable: true,
        },
      ],
    })

    renderFilesPage()

    // The unreadable file's ⋯ menu offers no Preview and no Download — the same
    // guard openResource already enforces — so no enabled action can 403.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for locked.md' }))
    })
    const lockedMenu = screen.getByRole('menu', { name: 'Actions for locked.md' })
    expect(within(lockedMenu).queryByRole('menuitem', { name: 'Preview' })).toBeNull()
    expect(within(lockedMenu).queryByRole('menuitem', { name: 'Download' })).toBeNull()

    // A readable, previewable file still offers both.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for open.md' }))
    })
    const openMenu = screen.getByRole('menu', { name: 'Actions for open.md' })
    expect(within(openMenu).getByRole('menuitem', { name: 'Preview' })).toBeTruthy()
    expect(within(openMenu).getByRole('menuitem', { name: 'Download' })).toBeTruthy()
  })

  it('uses a size column and keeps folder rows focused on the icon and name', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'dir-1',
          rid: 'dir-1',
          gfsUri: 'gfs://main/dir-1',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'Moon',
          kind: 'directory',
          path: '/Moon',
          version: 1,
          bytes: 0,
          coversDescendants: true,
        },
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'notes.txt',
          kind: 'file',
          path: '/notes.txt',
          version: 1,
          bytes: 2048,
        },
      ],
    })

    renderFilesPage()

    const header = document.querySelector('.da-gfs-drive__grid .da-grid__head')
    expect(header?.textContent).toContain('Size')
    expect(header?.textContent).not.toContain('Type')

    const folderRow = screen.getByText('Moon').closest('.da-grid__row')
    expect(folderRow?.querySelector('.da-gfs-drive__size')?.textContent).toBe('—')
    expect(folderRow?.querySelector('.da-gfs-list__meta')).toBeNull()
    expect(folderRow?.textContent).not.toContain('Folder')
    expect(folderRow?.textContent).not.toContain('Shared folder tree')

    const fileRow = screen.getByText('notes.txt').closest('.da-grid__row')
    expect(fileRow?.querySelector('.da-gfs-drive__size')?.textContent).toBe('2.0 KB')
  })

  it('shows end-user folder CRUD controls only when held permissions allow them', async () => {
    const createFolder = vi.fn(async () => undefined)
    const renameResource = vi.fn(async () => undefined)
    const deleteResource = vi.fn(async () => undefined)
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write', 'delete', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFolder,
      renameResource,
      deleteResource,
    })

    renderFilesPage()

    expect(screen.queryByText('Manage folder')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const newFolderDialog = screen.getByRole('dialog', { name: 'New folder' })
    const createFolderForm = screen.getByRole('form', { name: 'Create folder' })
    expect(within(newFolderDialog).queryByText('People with access')).toBeNull()
    expect(within(newFolderDialog).queryByText(/Add people/)).toBeNull()
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'new-folder' } })
      fireEvent.click(createFolderForm.querySelector('button[type="submit"]')!)
    })

    await chooseResourceAction('Team folder', 'Rename')
    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'renamed' } })
      fireEvent.click(renameForm.querySelector('button[type="submit"]')!)
    })

    await chooseResourceAction('Team folder', 'Delete')
    const deleteDialog = screen.getByRole('dialog', { name: 'Delete Team folder?' })
    await act(async () => {
      fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))
    })

    expect(createFolder).toHaveBeenCalledWith('new-folder')
    expect(renameResource).toHaveBeenCalledWith('folder-1', 'renamed', 7)
    expect(deleteResource).toHaveBeenCalledWith('folder-1', 7)
  })

  it('shows top-right create and upload actions for the open writable folder', async () => {
    const createFileFromPath = vi.fn(async () => undefined)
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage()

    const toolbar = document.querySelector('.da-gfs-drive__header-actions')
    const newFolderButton = screen.getByRole('button', { name: 'New folder' })
    const uploadButton = screen.getByRole('button', { name: 'Upload file' })
    expect(toolbar?.contains(newFolderButton)).toBe(true)
    expect(toolbar?.contains(uploadButton)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open EvenDrive link' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Options for Team folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open EvenDrive link' }))
    expect(screen.getByRole('dialog', { name: 'Open EvenDrive link' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close EvenDrive link dialog' }))

    fireEvent.click(newFolderButton)
    const newFolderDialog = screen.getByRole('dialog', { name: 'New folder' })
    const createFolderForm = screen.getByRole('form', { name: 'Create folder' })
    expect(within(newFolderDialog).getByRole('heading', { name: 'New folder' })).toBeTruthy()
    expect(newFolderDialog.classList.contains('da-gfs-new-folder-dialog')).toBe(true)
    expect(within(newFolderDialog).queryByText('People with access')).toBeNull()
    expect(createFolderForm.querySelector('.da-gfs-new-folder-dialog__actions')).not.toBeNull()
    fireEvent.click(within(createFolderForm).getByRole('button', { name: 'Cancel' }))

    const upload = new File(['desktop file'], 'notes.md', { type: 'text/markdown' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Upload file'), { target: { files: [upload] } })
      await Promise.resolve()
    })

    expect(createFileFromPath).toHaveBeenCalledWith('folder-1', 'notes.md', '/tmp/notes.md')
  })

  it('hides top-right create and upload actions without write access to the open folder', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Restricted folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })

    renderFilesPage()

    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload file' })).toBeNull()
    expect(screen.queryByLabelText('Upload file')).toBeNull()
  })

  it('does not render a folder upload control inside the manage dialog', async () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })

    renderFilesPage()

    await openManageDialog('Team folder')
    const dialog = screen.getByRole('dialog', { name: 'Share folder Team folder' })
    expect(within(dialog).queryByRole('button', { name: 'Upload file' })).toBeNull()
    expect(within(dialog).queryByLabelText('Upload file')).toBeNull()
  })

  it('uploads dropped files into the open writable folder', async () => {
    const createFileFromPath = vi.fn(
      async (_parentResourceId: string, _name: string, _filePath: string) => undefined
    )
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage(pushToast)
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const image = new File(['desktop image'], 'diagram.png', { type: 'image/png' })
    const markdown = new File(['# Desktop notes'], 'notes.markdown', { type: 'text/markdown' })
    const video = new File(['desktop video'], 'clip.mov', { type: 'video/quicktime' })
    const dataTransfer = { dropEffect: 'none', files: [image, markdown, video], types: ['Files'] }

    fireEvent.dragEnter(browser, { dataTransfer })
    const dropStatus = screen.getByRole('status')
    expect(dropStatus.textContent).toContain('Drop files to upload to Team folder')
    expect(dropStatus.className).toContain('composer-drop-overlay')

    await act(async () => {
      fireEvent.drop(browser, { dataTransfer })
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(createFileFromPath).toHaveBeenCalledWith('folder-1', 'diagram.png', '/tmp/diagram.png')
    )
    expect(createFileFromPath).toHaveBeenCalledWith(
      'folder-1',
      'notes.markdown',
      '/tmp/notes.markdown'
    )
    expect(createFileFromPath).toHaveBeenCalledWith('folder-1', 'clip.mov', '/tmp/clip.mov')
    expect(pushToast).toHaveBeenCalledWith('Uploaded diagram.png', 'success')
    expect(pushToast).toHaveBeenCalledWith('Uploaded notes.markdown', 'success')
    expect(pushToast).toHaveBeenCalledWith('Uploaded clip.mov', 'success')
  })

  it('adds numbered suffixes for duplicate names in one dropped batch', async () => {
    const createFileFromPath = vi.fn(
      async (_parentResourceId: string, _name: string, _filePath: string) => undefined
    )
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      items: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'report.txt',
          kind: 'file',
          path: '/report.txt',
          version: 1,
          bytes: 12,
        },
      ],
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage(pushToast)
    fireEvent.drop(screen.getByRole('region', { name: 'EvenDrive browser' }), {
      dataTransfer: {
        dropEffect: 'none',
        files: [
          new File(['first'], 'report.txt', { type: 'text/plain' }),
          new File(['second'], 'report.txt', { type: 'text/plain' }),
        ],
        types: ['Files'],
      },
    })

    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(2))
    expect(createFileFromPath.mock.calls.map(call => call[1])).toEqual([
      'report (1).txt',
      'report (2).txt',
    ])
    expect(pushToast).toHaveBeenCalledWith('Uploaded report (1).txt', 'success')
    expect(pushToast).toHaveBeenCalledWith('Uploaded report (2).txt', 'success')
  })

  it('adds a numbered suffix when a duplicate is selected with the upload picker', async () => {
    const createFileFromPath = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      items: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'report.txt',
          kind: 'file',
          path: '/report.txt',
          version: 1,
          bytes: 12,
        },
      ],
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage(pushToast)
    fireEvent.change(screen.getByLabelText('Upload file'), {
      target: { files: [new File(['report'], 'report.txt', { type: 'text/plain' })] },
    })

    await waitFor(() =>
      expect(createFileFromPath).toHaveBeenCalledWith(
        'folder-1',
        'report (1).txt',
        '/tmp/report.txt'
      )
    )
    expect(pushToast).toHaveBeenCalledWith('Uploaded report (1).txt', 'success')
  })

  it('retries a stale duplicate conflict with the next available name', async () => {
    const createFileFromPath = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'gfs:createFileFromPath': Error: 409 Conflict: [object Object]"
        )
      )
      .mockResolvedValueOnce(undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage(pushToast)
    fireEvent.drop(screen.getByRole('region', { name: 'EvenDrive browser' }), {
      dataTransfer: {
        dropEffect: 'none',
        files: [new File(['report'], 'report.txt', { type: 'text/plain' })],
        types: ['Files'],
      },
    })

    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(2))
    expect(createFileFromPath.mock.calls.map(call => call[1])).toEqual([
      'report.txt',
      'report (1).txt',
    ])
    expect(pushToast).toHaveBeenCalledWith('Uploaded report (1).txt', 'success')
    expect(pushToast).not.toHaveBeenCalledWith(expect.stringContaining('409 Conflict'), 'error')
  })

  it('allows a Markdown drop to retry immediately after an upload failure', async () => {
    const createFileFromPath = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary upload failure'))
      .mockResolvedValueOnce(undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage(pushToast)
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const firstDrop = {
      dropEffect: 'none',
      files: [new File(['# First'], 'first.md', { type: 'text/markdown' })],
      types: ['Files'],
    }
    const retryDrop = {
      dropEffect: 'none',
      files: [new File(['# Retry'], 'retry.md', { type: 'text/markdown' })],
      types: ['Files'],
    }

    await act(async () => {
      fireEvent.drop(browser, { dataTransfer: firstDrop })
      await Promise.resolve()
    })
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('temporary upload failure', 'error'))

    await act(async () => {
      fireEvent.drop(browser, { dataTransfer: retryDrop })
      await Promise.resolve()
    })

    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(2))
    expect(createFileFromPath).toHaveBeenLastCalledWith('folder-1', 'retry.md', '/tmp/retry.md')
    expect(pushToast).toHaveBeenCalledWith('Uploaded retry.md', 'success')
  })

  it('pins every file in a dropped batch to the folder where the drop started', async () => {
    const folderA = {
      resourceId: 'folder-a',
      rid: 'folder-a',
      gfsUri: 'gfs://main/folder-a',
      drive: 'main',
      parentResourceId: null,
      name: 'Private folder',
      kind: 'directory' as const,
      path: '/private',
      version: 1,
      bytes: 0,
    }
    const folderB = {
      ...folderA,
      resourceId: 'folder-b',
      rid: 'folder-b',
      gfsUri: 'gfs://main/folder-b',
      name: 'Shared folder',
      path: '/shared',
    }
    let releaseFirstUpload: (() => void) | undefined
    const createFileFromPath = vi.fn(
      (_parentResourceId: string, _name: string, _filePath: string) =>
        createFileFromPath.mock.calls.length === 1
          ? new Promise<void>(resolve => {
              releaseFirstUpload = resolve
            })
          : Promise.resolve()
    )

    function useChangingFolderController() {
      const [current, setCurrent] = useState(folderA)
      return {
        ...baseController(),
        current,
        items: current.resourceId === folderA.resourceId ? [folderB] : [],
        affordances: {
          held: ['read', 'write'],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        },
        createFileFromPath,
        openChild: (resource: typeof folderB) => setCurrent(resource),
      }
    }
    hookMock.useGfsBrowserController.mockImplementation(useChangingFolderController)

    renderFilesPage()
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const dataTransfer = {
      dropEffect: 'none',
      files: [
        new File(['# First'], 'first.md', { type: 'text/markdown' }),
        new File(['# Second'], 'second.md', { type: 'text/markdown' }),
      ],
      types: ['Files'],
    }

    fireEvent.drop(browser, { dataTransfer })
    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Shared folder' }))
    releaseFirstUpload?.()

    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(2))
    expect(createFileFromPath.mock.calls.map(call => call[0])).toEqual(['folder-a', 'folder-a'])
  })

  it('rejects oversized dropped files before reading or uploading them', async () => {
    const createFileFromPath = vi.fn()
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })
    const oversized = new File(['small fixture'], 'oversized.md', { type: 'text/markdown' })
    Object.defineProperty(oversized, 'size', { value: GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES + 1 })
    const arrayBuffer = vi.spyOn(oversized, 'arrayBuffer')

    renderFilesPage(pushToast)
    fireEvent.drop(screen.getByRole('region', { name: 'EvenDrive browser' }), {
      dataTransfer: { dropEffect: 'none', files: [oversized], types: ['Files'] },
    })

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        'GFS uploads cannot exceed the 1 GiB Upload v2 protocol maximum.',
        'error'
      )
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(createFileFromPath).not.toHaveBeenCalled()
  })

  it('keeps cached write access available while affordances refresh', async () => {
    const createFileFromPath = vi.fn(async () => undefined)
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      loadingAffordances: true,
      createFileFromPath,
    })

    renderFilesPage()
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const dataTransfer = {
      dropEffect: 'none',
      files: [new File(['# Notes'], 'notes.md', { type: 'text/markdown' })],
      types: ['Files'],
    }
    fireEvent.dragEnter(browser, { dataTransfer })

    expect(screen.getByRole('status').textContent).toContain('Drop files to upload to Team folder')
    fireEvent.drop(browser, { dataTransfer })
    await waitFor(() =>
      expect(createFileFromPath).toHaveBeenCalledWith('folder-1', 'notes.md', '/tmp/notes.md')
    )
  })

  it('explains why dropped preview files cannot be uploaded without folder write permission', () => {
    const createFileFromPath = vi.fn()
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Restricted folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFileFromPath,
    })

    renderFilesPage(pushToast)
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const image = new File(['desktop image'], 'restricted.png', { type: 'image/png' })
    const dataTransfer = { dropEffect: 'none', files: [image], types: ['Files'] }
    const reason =
      'You can’t upload to Restricted folder because you don’t have write permission for this folder.'

    fireEvent.dragEnter(browser, { dataTransfer })
    expect(screen.getByRole('status').textContent).toContain(reason)
    fireEvent.drop(browser, { dataTransfer })

    expect(createFileFromPath).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(reason, 'error')
  })

  it('surfaces a non-empty folder delete denial without closing the confirmation', async () => {
    const deleteResource = vi.fn(async () => {
      throw new Error('not_empty: folder has children')
    })
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Team folder',
        kind: 'directory',
        version: 7,
      },
      affordances: {
        held: ['read', 'delete', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      deleteResource,
    })

    renderFilesPage(pushToast)

    await chooseResourceAction('Team folder', 'Delete')
    const deleteDialog = screen.getByRole('dialog', { name: 'Delete Team folder?' })
    await act(async () => {
      fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))
      await Promise.resolve()
    })

    expect(deleteResource).toHaveBeenCalledWith('folder-1', 7)
    expect(pushToast).toHaveBeenCalledWith('not_empty: folder has children', 'error')
    expect(screen.queryByRole('dialog', { name: 'Delete Team folder?' })).toBeNull()
  })

  it('surfaces stale replace and rename precondition failures for the current file', async () => {
    const replaceFileFromPath = vi.fn(async () => {
      throw new Error('precondition_failed: stale file version')
    })
    const renameResource = vi.fn(async () => {
      throw new Error('precondition_failed: stale resource version')
    })
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'file-1',
        gfsUri: 'gfs://main/file-1',
        name: 'report.txt',
        kind: 'file',
        version: 7,
      },
      affordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      replaceFileFromPath,
      renameResource,
    })

    renderFilesPage(pushToast)

    await openManageDialog('report.txt')
    const manageDialog = screen.getByRole('dialog', { name: 'Share file report.txt' })
    expect(
      within(manageDialog).queryByRole('button', { name: 'Options for report.txt' })
    ).toBeNull()
    fireEvent.click(within(manageDialog).getByRole('button', { name: 'Close share dialog' }))
    await chooseResourceAction('report.txt', 'Replace file')
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Replace report.txt'), {
        target: {
          files: [new File(['replacement'], 'report.txt', { type: 'text/plain' })],
        },
      })
      await Promise.resolve()
    })
    await chooseResourceAction('report.txt', 'Rename')
    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New name'), {
        target: { value: 'report-renamed.txt' },
      })
      fireEvent.click(renameForm.querySelector('button[type="submit"]')!)
      await Promise.resolve()
    })

    expect(replaceFileFromPath).toHaveBeenCalledWith('file-1', '/tmp/report.txt', 7)
    expect(renameResource).toHaveBeenCalledWith('file-1', 'report-renamed.txt', 7)
    expect(pushToast).toHaveBeenCalledWith('precondition_failed: stale file version', 'error')
    expect(pushToast).toHaveBeenCalledWith('precondition_failed: stale resource version', 'error')
  })

  it('hides the Manage menu entry on rows the caller cannot manage (read-only access)', async () => {
    const child = {
      resourceId: 'child-1',
      rid: 'child-1',
      gfsUri: 'gfs://main/child-1',
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'notes.txt',
      kind: 'file' as const,
      path: '/Product/notes.txt',
      version: 3,
      bytes: 2048,
    }
    const controller = {
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      items: [child],
    }

    // Read-only row: the ⋯ menu must not offer Manage — the ACL modal would
    // only 403 on open (view-ACL = manage-ACL server-side).
    hookMock.useGfsBrowserController.mockReturnValue({
      ...controller,
      rowAffordancesResourceId: 'child-1',
      rowAffordances: {
        held: ['read'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })
    const view = renderFilesPage()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for notes.txt' }))
    })
    expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()

    // Same row with manage_acl held: the entry appears and opens the modal.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...controller,
      rowAffordancesResourceId: 'child-1',
      rowAffordances: {
        held: ['read', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })
    await act(async () => {
      view.rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <FilesPage />
        </QueryClientProvider>
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }))
    })
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Share options for notes.txt' })).getByRole(
          'menuitem',
          { name: 'Share' }
        )
      )
    })
    // The manage modal opens (titled for the current selection — the mocked
    // controller does not navigate, so it stays on the parent folder).
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'People with access' })).toBeTruthy()
  })

  it('returns to Shared with me after closing Manage for a file row', async () => {
    const managedFile = {
      resourceId: 'file-1',
      rid: 'file-1',
      gfsUri: 'gfs://main/file-1',
      drive: 'main',
      parentResourceId: null,
      name: 'report.txt',
      kind: 'file' as const,
      path: '/report.txt',
      version: 7,
      bytes: 128,
      sources: ['grant'],
      permissions: ['read', 'write', 'manage_acl'],
      coversDescendants: false,
    }
    const restoreCrumbs = vi.fn()

    function useManageFileController() {
      const [crumbs, setCrumbs] = useState<GfsCrumb[]>([])
      const current = crumbs.at(-1) ?? null
      return {
        ...baseController(),
        current,
        crumbs,
        accessibleResources: current ? [] : [managedFile],
        affordances: current
          ? {
              held: ['read', 'write', 'manage_acl'],
              canDelegate: false,
              grantableBits: [],
              canCreateShare: false,
            }
          : null,
        openResource: (resource: typeof managedFile) =>
          setCrumbs([
            {
              resourceId: resource.resourceId,
              gfsUri: resource.gfsUri,
              name: resource.name,
              kind: resource.kind,
              version: resource.version,
              bytes: resource.bytes,
            },
          ]),
        restoreCrumbs: (nextCrumbs: GfsCrumb[]) => {
          restoreCrumbs(nextCrumbs)
          setCrumbs(nextCrumbs)
        },
      }
    }
    hookMock.useGfsBrowserController.mockImplementation(useManageFileController)

    renderFilesPage()
    await openManageDialog('report.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Close share dialog' }))

    await waitFor(() => expect(restoreCrumbs).toHaveBeenCalledWith([]))
    expect(screen.getByRole('button', { name: 'report.txt' })).toBeTruthy()
    expect(screen.queryByText(/Preview this file again/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Options for Shared with me' })).toBeTruthy()
  })

  it('renames the current file inline from its title menu', async () => {
    const pushToast = vi.fn()
    const renameResource = vi.fn(async () => undefined)
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'file-1',
        gfsUri: 'gfs://main/file-1',
        name: 'report.txt',
        kind: 'file',
        version: 7,
      },
      affordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      renameResource,
    })

    renderFilesPage(pushToast)

    fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))

    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    expect(screen.getAllByRole('form', { name: 'Rename resource' })).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Rename resource' })).toBeNull()
    fireEvent.change(within(renameForm).getByLabelText('New name'), {
      target: { value: 'report-renamed.txt' },
    })
    fireEvent.click(within(renameForm).getByRole('button', { name: 'Save name' }))

    await waitFor(() =>
      expect(renameResource).toHaveBeenCalledWith('file-1', 'report-renamed.txt', 7)
    )
    expect(pushToast).toHaveBeenCalledWith('Renamed to report-renamed.txt', 'success')
  })

  it('uses the visible team directory for user delegation subjects', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        team: {
          directory: vi.fn(async () => ({
            currentTeamId: 'team-1',
            items: [
              {
                team: { id: 'team-1', name: 'Core Team', role: 'admin' },
                members: [
                  {
                    id: 'user-2',
                    email: 'test2@clerum.io',
                    name: 'Test Two',
                    role: 'member',
                    status: 'active',
                  },
                ],
                contextIds: [],
                agentNames: [],
              },
            ],
          })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: false,
      },
    })

    renderFilesPage()

    await openManageDialog('Team folder')

    const subjectPicker = await screen.findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    await waitFor(() => expect(subjectPicker).toHaveProperty('disabled', false))
    fireEvent.focus(subjectPicker)
    const userLabel = await screen.findByText('Test Two')
    expect(userLabel.closest('[role="option"]')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/uuid/i)).toBeNull()
  })

  it('loads my agents when the manage dialog opens and offers only valid gfs subjects', async () => {
    const listMine = vi.fn(async () => [
      {
        name: 'chatllm',
        contextRef: 'ctx-1',
        mcpServers: [],
        gfsSubject: { type: 'host', id: '1st:mcp-host/chatllm' },
      },
      // No canonical gfsSubject yet — not a grantable delegation target.
      { name: 'pending-agent', contextRef: null, mcpServers: [] },
    ])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: { listMine },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: false,
      },
    })

    renderFilesPage()
    expect(listMine).not.toHaveBeenCalled()

    await openManageDialog('Team folder')

    await waitFor(() => expect(listMine).toHaveBeenCalledTimes(1))
    const picker = await screen.findByRole('combobox', { name: 'Add people, teams, or agents' })
    fireEvent.focus(picker)
    expect(await screen.findByRole('option', { name: /chatllm/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /pending-agent/ })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Include contents of this folder' })).toBeNull()
  })

  it('refetches the grants list after a successful agent grant', async () => {
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
      },
    })
    const grant = vi.fn(async () => undefined)
    const refreshGrants = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read', 'write'],
        canCreateShare: false,
      },
      grant,
      refreshGrants,
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')

    const picker = await screen.findByRole('combobox', { name: 'Add people, teams, or agents' })
    fireEvent.focus(picker)
    fireEvent.click(await screen.findByRole('option', { name: /chatllm/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith(['host:1st:mcp-host/chatllm'], ['read'], true)
    )
    await waitFor(() => expect(refreshGrants).toHaveBeenCalledTimes(1))
    expect(pushToast).toHaveBeenCalledWith('Access granted to 1 subject', 'success')
  })

  it('refetches the grants list after a successful user or team grant', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: { listMine: vi.fn(async () => []) },
        team: {
          directory: vi.fn(async () => ({
            currentTeamId: 'team-1',
            items: [
              {
                team: { id: 'team-1', name: 'Core Team', role: 'admin' },
                members: [
                  {
                    id: 'user-2',
                    email: 'test2@clerum.io',
                    name: 'Test Two',
                    role: 'member',
                    status: 'active',
                  },
                ],
                contextIds: [],
                agentNames: [],
              },
            ],
          })),
        },
      },
    })
    const grant = vi.fn(async () => undefined)
    const refreshGrants = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: false,
      },
      grant,
      refreshGrants,
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')

    const subjectPicker = await screen.findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    fireEvent.focus(subjectPicker)
    fireEvent.click(await screen.findByRole('option', { name: /Test Two/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    // handleGrant issues the grant then MUST list-after-write (the grant PUT
    // returns no ids). Deleting `await ctrl.refreshGrants()` must fail here.
    await waitFor(() => expect(grant).toHaveBeenCalledWith(['user:user-2'], ['read'], true))
    await waitFor(() => expect(refreshGrants).toHaveBeenCalledTimes(1))
    expect(pushToast).toHaveBeenCalledWith('Access granted to 1 subject', 'success')
  })

  // TASK-243 — inherited access on a FILE: one normal toggleable row per
  // member; any edit confirms against the parent folder and applies there.
  function inheritedFileController(overrides: Record<string, unknown> = {}) {
    return {
      ...baseController(),
      current: {
        resourceId: 'file-1',
        gfsUri: 'gfs://main/file-1',
        name: 'report.txt',
        kind: 'file' as const,
        version: 3,
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read', 'share', 'write'],
        canCreateShare: false,
      },
      grants: [
        {
          id: 'grant-1',
          drive: 'main',
          resourceId: 'file-1',
          subject: { type: 'user', id: 'user-2' },
          permissions: ['read', 'share'],
          inherit: false,
        },
      ],
      inheritedAccess: [
        {
          subject: { type: 'user', id: 'user-2' },
          permissions: ['read', 'write'],
          inheritedFrom: ['Team folder'],
          sources: [
            {
              resourceId: 'folder-1',
              name: 'Team folder',
              permissions: ['read', 'write'],
              grantId: 'parent-grant-1',
              shareIds: [],
            },
          ],
        },
      ],
      ...overrides,
    }
  }

  function installInheritedDirectoryMocks() {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          getPathForFile: vi.fn((file: File) => `/tmp/${file.name}`),
          grant: vi.fn(async () => undefined),
          affordances: vi.fn(async () => ({
            held: ['read', 'write', 'share', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read', 'share', 'write', 'delete', 'manage_acl'],
            canCreateShare: true,
          })),
        },
        agents: { listMine: vi.fn(async () => []) },
        team: {
          directory: vi.fn(async () => ({
            currentTeamId: 'team-1',
            items: [
              {
                team: { id: 'team-1', name: 'Core Team', role: 'admin' },
                members: [
                  {
                    id: 'user-2',
                    email: 'test2@clerum.io',
                    name: 'Test Two',
                    role: 'member',
                    status: 'active',
                  },
                ],
                contextIds: [],
                agentNames: [],
              },
            ],
          })),
        },
      },
    })
  }

  it('shows one normal toggleable row per member with inherited access on a file', async () => {
    installInheritedDirectoryMocks()
    hookMock.useGfsBrowserController.mockReturnValue(inheritedFileController())

    renderFilesPage()
    await openManageDialog('report.txt')

    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    // Direct grant row is consumed by the deduped merged row (one per member).
    expect(within(manageDialog).queryByTestId('gfs-access-row-grant-grant-1')).toBeNull()
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')
    expect(within(row).getByText('Test Two')).toBeTruthy()
    expect(within(row).queryByText(/Inherited from/)).toBeNull()
    // Effective role is the strongest across direct and inherited sources.
    expect(
      within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
    ).toContain('Editor')
  })

  it('confirms an inherited role change against the parent folder and applies it there', async () => {
    installInheritedDirectoryMocks()
    const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> }).grant
    const refreshGrants = vi.fn(async () => undefined)
    const refreshInheritedAccess = vi.fn(async () => undefined)
    const fileGrant = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue(
      inheritedFileController({ refreshGrants, refreshInheritedAccess, grant: fileGrant })
    )

    renderFilesPage(pushToast)
    await openManageDialog('report.txt')
    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    })

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(
      within(confirmDialog).getByText('Update role on parent folder?', { selector: 'h3' })
    ).toBeTruthy()
    expect(within(confirmDialog).getByText('Team folder')).toBeTruthy()
    expect(within(confirmDialog).getByText('report.txt')).toBeTruthy()

    // Cancel reverts the dropdown and sends nothing.
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(parentGrant).not.toHaveBeenCalled()
    expect(
      within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
    ).toContain('Editor')

    // Confirm applies the new role to the parent folder grant first…
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    })
    const confirmDialogAgain = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(confirmDialogAgain).getByRole('button', { name: 'Update role' }))
    })

    await waitFor(() =>
      expect(parentGrant).toHaveBeenCalledWith(
        'folder-1',
        ['user:user-2'],
        ['read', 'share'],
        'main',
        true
      )
    )
    // …then aligns the file's own direct grant so it cannot mask the role.
    await waitFor(() =>
      expect(fileGrant).toHaveBeenCalledWith(['user:user-2'], ['read', 'share'], false)
    )
    await waitFor(() => expect(refreshGrants).toHaveBeenCalled())
    await waitFor(() => expect(refreshInheritedAccess).toHaveBeenCalled())
  })

  // R1-H2 — a stale direct file share must not survive a confirmed parent
  // role change: the editor share would keep masking the confirmed downgrade
  // while the toast claims Read-only.
  it('revokes the file’s direct shares when a confirmed parent role change downgrades the member', async () => {
    installInheritedDirectoryMocks()
    const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> }).grant
    const directShare = {
      id: 'file-share-1',
      drive: 'main',
      resourceId: 'file-1',
      subject: { type: 'user', id: 'user-2' },
      permissions: ['read', 'write'],
      includeDescendants: false,
    }
    const inheritedEditor = {
      subject: { type: 'user', id: 'user-2' },
      permissions: ['read', 'write'],
      inheritedFrom: ['Team folder'],
      sources: [
        {
          resourceId: 'folder-1',
          name: 'Team folder',
          permissions: ['read', 'write'],
          grantId: 'parent-grant-1',
          shareIds: [],
        },
      ],
    }
    const inheritedSource = inheritedEditor.sources[0]!
    let refreshShareQuery: (() => void) | undefined
    let completeShareRefresh: (() => void) | undefined
    let downgradeInherited: (() => void) | undefined
    parentGrant.mockImplementation(async () => {
      downgradeInherited?.()
    })
    const fileGrant = vi.fn(async () => undefined)
    const revokeShare = vi.fn(async () => undefined)
    const refreshShares = vi.fn(
      () =>
        new Promise<void>(resolve => {
          completeShareRefresh = () => {
            refreshShareQuery?.()
            resolve()
          }
        })
    )
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockImplementation(() => {
      const [shares, setShares] = useState([directShare])
      const [inheritedAccess, setInheritedAccess] = useState([inheritedEditor])
      refreshShareQuery = () => setShares([])
      downgradeInherited = () =>
        setInheritedAccess([
          {
            ...inheritedEditor,
            permissions: ['read'],
            sources: [{ ...inheritedSource, permissions: ['read'] }],
          },
        ])
      return inheritedFileController({
        grants: [],
        shares,
        inheritedAccess,
        grant: fileGrant,
        revokeShare,
        refreshShares,
      })
    })

    renderFilesPage(pushToast)
    await openManageDialog('report.txt')
    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    // The direct share row is consumed by the deduped merged row.
    expect(within(manageDialog).queryByTestId('gfs-access-row-share-file-share-1')).toBeNull()
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')
    expect(
      within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
    ).toContain('Editor')

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    })
    const confirmDialog = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Update role' }))
    })

    // The revoke mutation does not alter rendered/query state by itself.
    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('file-share-1'))
    expect(
      within(screen.getByTestId('gfs-access-row-inherited-user:user-2')).getByRole('button', {
        name: 'Access role for Test Two',
      }).textContent
    ).toContain('Editor')
    // …after the replacement grant expresses the confirmed role.
    await waitFor(() =>
      expect(fileGrant).toHaveBeenCalledWith(['user:user-2'], ['read', 'share'], false)
    )
    await waitFor(() => expect(refreshShares).toHaveBeenCalledTimes(1))
    expect(
      within(screen.getByTestId('gfs-access-row-inherited-user:user-2')).getByRole('button', {
        name: 'Access role for Test Two',
      }).textContent
    ).toContain('Editor')
    await act(async () => {
      completeShareRefresh?.()
    })
    await waitFor(() =>
      expect(
        within(screen.getByTestId('gfs-access-row-inherited-user:user-2')).getByRole('button', {
          name: 'Access role for Test Two',
        }).textContent
      ).toContain('Read')
    )
    expect(pushToast).toHaveBeenCalledWith(
      'Test Two is now Read-only on Team folder and everything inside it',
      'success'
    )
  })

  // R1-H2 — a partial revoke also waits for refreshed server-backed shares
  // before showing the effective role.
  it('refreshes shares after a partial inherited-access mutation failure', async () => {
    installInheritedDirectoryMocks()
    const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> }).grant
    const editorShare = {
      id: 'file-editor-share',
      drive: 'main',
      resourceId: 'file-1',
      subject: { type: 'user', id: 'user-2' },
      permissions: ['read', 'write'],
      includeDescendants: false,
    }
    const readShare = {
      ...editorShare,
      id: 'file-read-share',
      permissions: ['read'],
    }
    const inheritedEditor = {
      subject: { type: 'user', id: 'user-2' },
      permissions: ['read', 'write'],
      inheritedFrom: ['Team folder'],
      sources: [
        {
          resourceId: 'folder-1',
          name: 'Team folder',
          permissions: ['read', 'write'],
          grantId: 'parent-grant-1',
          shareIds: [],
        },
      ],
    }
    const inheritedSource = inheritedEditor.sources[0]!
    let refreshShareQuery: (() => void) | undefined
    let completeShareRefresh: (() => void) | undefined
    let downgradeInherited: (() => void) | undefined
    parentGrant.mockImplementation(async () => downgradeInherited?.())
    const revokeShare = vi
      .fn<(shareId: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('share revoke failed'))
    const refreshShares = vi.fn(
      () =>
        new Promise<void>(resolve => {
          completeShareRefresh = () => {
            refreshShareQuery?.()
            resolve()
          }
        })
    )
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockImplementation(() => {
      const [shares, setShares] = useState([editorShare, readShare])
      const [inheritedAccess, setInheritedAccess] = useState([inheritedEditor])
      refreshShareQuery = () => setShares([readShare])
      downgradeInherited = () =>
        setInheritedAccess([
          {
            ...inheritedEditor,
            permissions: ['read'],
            sources: [{ ...inheritedSource, permissions: ['read'] }],
          },
        ])
      return inheritedFileController({
        grants: [],
        shares,
        inheritedAccess,
        revokeShare,
        refreshShares,
      })
    })

    renderFilesPage(pushToast)
    await openManageDialog('report.txt')
    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')

    expect(
      within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
    ).toContain('Editor')
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    })
    const confirmDialog = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Update role' }))
    })

    await waitFor(() => expect(revokeShare).toHaveBeenCalledTimes(2))
    expect(revokeShare).toHaveBeenNthCalledWith(1, 'file-editor-share')
    expect(revokeShare).toHaveBeenNthCalledWith(2, 'file-read-share')
    await waitFor(() => expect(refreshShares).toHaveBeenCalledTimes(1))
    expect(
      within(screen.getByTestId('gfs-access-row-inherited-user:user-2')).getByRole('button', {
        name: 'Access role for Test Two',
      }).textContent
    ).toContain('Editor')
    await act(async () => {
      completeShareRefresh?.()
    })
    await waitFor(() =>
      expect(
        within(screen.getByTestId('gfs-access-row-inherited-user:user-2')).getByRole('button', {
          name: 'Access role for Test Two',
        }).textContent
      ).toContain('Read')
    )
    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining('direct access on report.txt could not be fully aligned'),
      'error'
    )
  })

  // R1-M1 — the parent grant's bits are judged by the PARENT folder's
  // grantable bits, never by the open file's affordances (which may be null
  // or narrower than what the folder allows).
  it('derives the parent grant bits from the parent folder affordances, not the file', async () => {
    installInheritedDirectoryMocks()
    const folderAffordances = (
      window.clerum.gfs as unknown as { affordances: ReturnType<typeof vi.fn> }
    ).affordances
    const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> }).grant
    const pushToast = vi.fn()
    // The file's grantable bits came back empty (failed/narrow probe) — the
    // legacy path built the parent bits from these and confirmed a [] grant.
    hookMock.useGfsBrowserController.mockReturnValue(
      inheritedFileController({
        affordances: {
          held: ['read', 'write', 'share', 'manage_acl'],
          canDelegate: true,
          grantableBits: [],
          canCreateShare: false,
        },
      })
    )

    renderFilesPage(pushToast)
    await openManageDialog('report.txt')
    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    })

    // Pre-flight judged the parent folder itself before opening the modal.
    await waitFor(() => expect(folderAffordances).toHaveBeenCalledWith('folder-1', 'main'))
    const confirmDialog = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Update role' }))
    })

    await waitFor(() =>
      expect(parentGrant).toHaveBeenCalledWith(
        'folder-1',
        ['user:user-2'],
        ['read', 'share'],
        'main',
        true
      )
    )
    expect(pushToast).toHaveBeenCalledWith(
      'Test Two is now Read-only on Team folder and everything inside it',
      'success'
    )
  })

  it('refuses a role the parent folder cannot grant, before opening the confirmation', async () => {
    installInheritedDirectoryMocks()
    ;(
      window.clerum.gfs as unknown as { affordances: ReturnType<typeof vi.fn> }
    ).affordances.mockResolvedValue({
      held: ['read', 'share'],
      canDelegate: true,
      grantableBits: ['read', 'share'],
      canCreateShare: false,
    })
    const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> }).grant
    const pushToast = vi.fn()
    // Read-only inherited floor: upgrading to Editor must be judged against
    // the folder, which cannot grant write.
    hookMock.useGfsBrowserController.mockReturnValue(
      inheritedFileController({
        inheritedAccess: [
          {
            subject: { type: 'user', id: 'user-2' },
            permissions: ['read'],
            inheritedFrom: ['Team folder'],
            sources: [
              {
                resourceId: 'folder-1',
                name: 'Team folder',
                permissions: ['read'],
                grantId: 'parent-grant-1',
                shareIds: [],
              },
            ],
          },
        ],
      })
    )

    renderFilesPage(pushToast)
    await openManageDialog('report.txt')
    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')

    // Editor needs write on the parent; this folder cannot grant it.
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    })

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        'Your access on Team folder does not allow making Test Two an Editor.',
        'error'
      )
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(parentGrant).not.toHaveBeenCalled()
    // The dropdown reverts to the server-backed role.
    expect(
      within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
    ).toContain('Read')
  })

  // R1-M3 — a total derivation failure must not silently read as "no one".
  it('shows a quiet notice instead of the empty claim when the derivation fails', async () => {
    installInheritedDirectoryMocks()
    hookMock.useGfsBrowserController.mockReturnValue(
      inheritedFileController({
        grants: [],
        inheritedAccess: [],
        inheritedAccessError: 'Error invoking remote method: 500',
      })
    )

    renderFilesPage()
    await openManageDialog('report.txt')

    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    expect(
      await within(manageDialog).findByText(
        'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
      )
    ).toBeTruthy()
    expect(within(manageDialog).queryByText('No one has access yet.')).toBeNull()
  })

  it('removes an inherited member from the parent folder after confirmation', async () => {
    installInheritedDirectoryMocks()
    const revokeGrant = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue(inheritedFileController({ revokeGrant }))

    renderFilesPage(pushToast)
    await openManageDialog('report.txt')
    const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Actions for Test Two' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    })

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(
      within(confirmDialog).getByText('Remove from parent folder?', { selector: 'h3' })
    ).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Remove' }))
    })

    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('parent-grant-1'))
  })

  // R1-H1 — Drive-aligned multi-ancestor semantics. Reference scenario:
  // Marketing (Viewer) → Campaigns (Editor) → report.txt.
  describe('R1-H1 multi-ancestor edits', () => {
    const CAMPAIGNS = {
      resourceId: 'folder-cmp',
      name: 'Campaigns',
      permissions: ['read', 'write'],
      grantId: 'cmp-grant-1',
      shareIds: [],
    }
    const MARKETING = {
      resourceId: 'folder-mkt',
      name: 'Marketing',
      permissions: ['read', 'share'],
      grantId: 'mkt-grant-1',
      shareIds: [],
    }
    const EDITOR_PERMISSIONS = ['read', 'write', 'delete', 'manage_acl', 'share']

    function multiSourceController(
      sources: Array<typeof CAMPAIGNS>,
      overrides: Record<string, unknown> = {}
    ) {
      const permissions = [...new Set(sources.flatMap(source => source.permissions))]
      return inheritedFileController({
        grants: [],
        inheritedAccess: [
          {
            subject: { type: 'user', id: 'user-2' },
            permissions,
            inheritedFrom: sources.map(source => source.name),
            sources,
          },
        ],
        ...overrides,
      })
    }

    async function openMultiSourceRow(
      sources: Array<typeof CAMPAIGNS>,
      pushToast?: (message: string, tone: Tone) => void
    ) {
      renderFilesPage(pushToast)
      await openManageDialog('report.txt')
      const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
      const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')
      return row
    }

    it('removes the member from every contributing ancestor and aligns the file rows', async () => {
      installInheritedDirectoryMocks()
      const revokeGrant = vi.fn(async () => undefined)
      const revokeShare = vi.fn(async () => undefined)
      const pushToast = vi.fn()
      const directShare = {
        id: 'file-share-1',
        drive: 'main',
        resourceId: 'file-1',
        subject: { type: 'user', id: 'user-2' },
        permissions: ['read', 'write'],
        includeDescendants: false,
      }
      hookMock.useGfsBrowserController.mockReturnValue(
        multiSourceController([CAMPAIGNS, MARKETING], {
          revokeGrant,
          revokeShare,
          shares: [directShare],
        })
      )

      const row = await openMultiSourceRow([CAMPAIGNS, MARKETING], pushToast)
      await act(async () => {
        fireEvent.click(within(row).getByRole('button', { name: 'Actions for Test Two' }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
      })

      const confirmDialog = await screen.findByRole('alertdialog')
      expect(within(confirmDialog).getByText('Remove from parent folder?', { selector: 'h3' }))
      // Every affected folder is listed with its own current role.
      expect(within(confirmDialog).getByText('Campaigns')).toBeTruthy()
      expect(within(confirmDialog).getByText('Marketing')).toBeTruthy()
      expect(within(confirmDialog).getByText('report.txt')).toBeTruthy()
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Remove' }))
      })

      // Both ancestors' grants are revoked…
      await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('cmp-grant-1'))
      await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('mkt-grant-1'))
      // …and the file's own direct share is aligned with the removal.
      await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('file-share-1'))
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          'Access removed on 2 folders and everything inside them',
          'success'
        )
      )
    })

    it('downgrades only the ancestors above the target role', async () => {
      installInheritedDirectoryMocks()
      const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> })
        .grant
      const pushToast = vi.fn()
      // Marketing is already at Read; Campaigns sits above the target.
      hookMock.useGfsBrowserController.mockReturnValue(
        multiSourceController([CAMPAIGNS, MARKETING])
      )

      const row = await openMultiSourceRow([CAMPAIGNS, MARKETING], pushToast)
      await act(async () => {
        fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('option', { name: 'Read' }))
      })

      const confirmDialog = await screen.findByRole('alertdialog')
      expect(within(confirmDialog).getByText('Campaigns')).toBeTruthy()
      expect(within(confirmDialog).queryByText('Marketing')).toBeNull()
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Update role' }))
      })

      // Exactly one folder mutation: the editor source is lowered, the
      // read-only source stays untouched.
      await waitFor(() => expect(parentGrant).toHaveBeenCalledTimes(1))
      expect(parentGrant).toHaveBeenCalledWith(
        'folder-cmp',
        ['user:user-2'],
        ['read', 'share'],
        'main',
        true
      )
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          'Test Two is now Read-only on Campaigns and everything inside it',
          'success'
        )
      )
    })

    it('raises exactly one strongest ancestor on upgrade', async () => {
      installInheritedDirectoryMocks()
      const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> })
        .grant
      const readCampaigns = { ...CAMPAIGNS, permissions: ['read', 'share'] }
      const readMarketing = { ...MARKETING }
      hookMock.useGfsBrowserController.mockReturnValue(
        multiSourceController([readCampaigns, readMarketing])
      )

      const row = await openMultiSourceRow([readCampaigns, readMarketing])
      await act(async () => {
        fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
      })

      const confirmDialog = await screen.findByRole('alertdialog')
      expect(within(confirmDialog).getByText('Campaigns')).toBeTruthy()
      expect(within(confirmDialog).queryByText('Marketing')).toBeNull()
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Update role' }))
      })

      // One raise on the nearest source is enough: effective = strongest.
      await waitFor(() => expect(parentGrant).toHaveBeenCalledTimes(1))
      expect(parentGrant).toHaveBeenCalledWith(
        'folder-cmp',
        ['user:user-2'],
        EDITOR_PERMISSIONS,
        'main',
        true
      )
    })

    // N1 — the dropdown shows the MERGED role (direct ⊔ inherited);
    // re-selecting the already-displayed role must be a no-op, not an
    // inherited-floor comparison that escalates the parent folder.
    it('re-selecting the displayed merged role opens no modal and issues no writes', async () => {
      installInheritedDirectoryMocks()
      const folderAffordances = (
        window.clerum.gfs as unknown as { affordances: ReturnType<typeof vi.fn> }
      ).affordances
      const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> })
        .grant
      const pushToast = vi.fn()
      // Direct Editor grant on the file + inherited Read floor: the row
      // displays Editor even though the inherited-only role is Read.
      hookMock.useGfsBrowserController.mockReturnValue(
        inheritedFileController({
          grants: [
            {
              id: 'grant-1',
              drive: 'main',
              resourceId: 'file-1',
              subject: { type: 'user', id: 'user-2' },
              permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
              inherit: false,
            },
          ],
          inheritedAccess: [
            {
              subject: { type: 'user', id: 'user-2' },
              permissions: ['read'],
              inheritedFrom: ['Team folder'],
              sources: [
                {
                  resourceId: 'folder-1',
                  name: 'Team folder',
                  permissions: ['read'],
                  grantId: 'parent-grant-1',
                  shareIds: [],
                },
              ],
            },
          ],
        })
      )

      renderFilesPage(pushToast)
      await openManageDialog('report.txt')
      const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
      const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')
      // The merged row displays the strongest role across sources.
      expect(
        within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
      ).toContain('Editor')

      await act(async () => {
        fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
      })

      // No confirmation, no pre-flight, no writes — the displayed role was
      // re-selected.
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(folderAffordances).not.toHaveBeenCalled()
      expect(parentGrant).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(
          within(row).getByRole('button', { name: 'Access role for Test Two' }).textContent
        ).toContain('Editor')
      )
    })

    // N2 — when the file's affordances are unavailable (empty grantable
    // bits), the old direct grant must be revoked so it cannot keep masking
    // the parent update.
    it('revokes an unexpressible direct grant and renders the effective role after refresh', async () => {
      installInheritedDirectoryMocks()
      const parentGrant = (window.clerum.gfs as unknown as { grant: ReturnType<typeof vi.fn> })
        .grant
      const editorGrant = {
        id: 'file-editor-grant',
        drive: 'main',
        resourceId: 'file-1',
        subject: { type: 'user', id: 'user-2' },
        permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
        inherit: false,
      }
      const inheritedEditor = {
        subject: { type: 'user', id: 'user-2' },
        permissions: ['read', 'write'],
        inheritedFrom: ['Team folder'],
        sources: [
          {
            resourceId: 'folder-1',
            name: 'Team folder',
            permissions: ['read', 'write'],
            grantId: 'parent-grant-1',
            shareIds: [],
          },
        ],
      }
      let removeEditorGrant: (() => void) | undefined
      let downgradeInherited: (() => void) | undefined
      parentGrant.mockImplementation(async () => {
        downgradeInherited?.()
      })
      const revokeGrant = vi.fn(async () => {
        removeEditorGrant?.()
      })
      const refreshGrants = vi.fn(async () => undefined)
      const refreshInheritedAccess = vi.fn(async () => undefined)
      const refreshShares = vi.fn(async () => undefined)
      const pushToast = vi.fn()
      hookMock.useGfsBrowserController.mockImplementation(() => {
        const [grants, setGrants] = useState([editorGrant])
        const [inheritedAccess, setInheritedAccess] = useState([inheritedEditor])
        removeEditorGrant = () => setGrants([])
        downgradeInherited = () =>
          setInheritedAccess([
            {
              ...inheritedEditor,
              permissions: ['read'],
              sources: [{ ...inheritedEditor.sources[0]!, permissions: ['read'] }],
            },
          ])
        return inheritedFileController({
          grants,
          inheritedAccess,
          affordances: {
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: [],
            canCreateShare: false,
          },
          revokeGrant,
          refreshGrants,
          refreshInheritedAccess,
          refreshShares,
        })
      })

      renderFilesPage(pushToast)
      await openManageDialog('report.txt')
      const manageDialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
      const row = await within(manageDialog).findByTestId('gfs-access-row-inherited-user:user-2')

      await act(async () => {
        fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('option', { name: 'Read' }))
      })
      const confirmDialog = await screen.findByRole('alertdialog')
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Update role' }))
      })

      // The parent update succeeded with its pre-validated folder bits…
      await waitFor(() =>
        expect(parentGrant).toHaveBeenCalledWith(
          'folder-1',
          ['user:user-2'],
          ['read', 'share'],
          'main',
          true
        )
      )
      // The stale direct Editor grant is revoked instead of being left to
      // mask the parent result.
      await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('file-editor-grant'))
      // The observable merged row now reflects the effective Read role after
      // both the parent and direct surfaces refresh.
      await waitFor(() =>
        expect(
          within(screen.getByTestId('gfs-access-row-inherited-user:user-2')).getByRole('button', {
            name: 'Access role for Test Two',
          }).textContent
        ).toContain('Read')
      )
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          'Test Two is now Read-only on Team folder and everything inside it',
          'success'
        )
      )
      pushToast.mock.calls.forEach(([message, tone]) => {
        expect(tone).not.toBe('error')
      })
    })

    it('states the true partial outcome when a folder removal fails mid-run', async () => {
      installInheritedDirectoryMocks()
      const revokeGrant = vi.fn(async (grantId: string) => {
        if (grantId === 'mkt-grant-1') {
          throw new Error('403 Forbidden: escalation_rejected')
        }
      })
      const refreshGrants = vi.fn(async () => undefined)
      const refreshInheritedAccess = vi.fn(async () => undefined)
      const pushToast = vi.fn()
      hookMock.useGfsBrowserController.mockReturnValue(
        multiSourceController([CAMPAIGNS, MARKETING], {
          revokeGrant,
          refreshGrants,
          refreshInheritedAccess,
        })
      )

      const row = await openMultiSourceRow([CAMPAIGNS, MARKETING], pushToast)
      await act(async () => {
        fireEvent.click(within(row).getByRole('button', { name: 'Actions for Test Two' }))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
      })
      const confirmDialog = await screen.findByRole('alertdialog')
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Remove' }))
      })

      // The nearest folder was removed; Marketing failed — the toast says
      // exactly how far the removal got, and both lists refresh to the TRUE
      // partial state.
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          expect.stringContaining('Removed from 1 of 2 folders — Marketing still grants access'),
          'error'
        )
      )
      expect(pushToast).not.toHaveBeenCalledWith(
        'Access removed on 2 folders and everything inside them',
        'success'
      )
      await waitFor(() => expect(refreshGrants).toHaveBeenCalled())
      await waitFor(() => expect(refreshInheritedAccess).toHaveBeenCalled())
    })
  })

  it('does not render resource options inside the share dialog', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: { listMine: vi.fn(async () => []) },
        team: {
          directory: vi.fn(async () => ({
            currentTeamId: 'team-1',
            items: [
              {
                team: { id: 'team-1', name: 'Core Team', role: 'admin' },
                members: [
                  {
                    id: 'user-2',
                    email: 'test2@clerum.io',
                    name: 'Test Two',
                    role: 'member',
                    status: 'active',
                  },
                ],
                contextIds: [],
                agentNames: [],
              },
            ],
          })),
        },
      },
    })
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'share', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read', 'share'],
        canCreateShare: true,
      },
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')

    const dialog = screen.getByRole('dialog', { name: 'Share folder Team folder' })
    expect(within(dialog).queryByRole('button', { name: 'Options for Team folder' })).toBeNull()
    expect(within(dialog).queryByRole('menu')).toBeNull()
  })

  it('issues ONE atomic bulk grant and does not refetch or toast when it is rejected', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: { listMine: vi.fn(async () => []) },
        team: {
          directory: vi.fn(async () => ({
            currentTeamId: 'team-1',
            items: [
              {
                team: { id: 'team-1', name: 'Core Team', role: 'admin' },
                members: [
                  {
                    id: 'user-2',
                    email: 'test2@clerum.io',
                    name: 'Test Two',
                    role: 'member',
                    status: 'active',
                  },
                  {
                    id: 'user-3',
                    email: 'test3@clerum.io',
                    name: 'Test Three',
                    role: 'member',
                    status: 'active',
                  },
                ],
                contextIds: [],
                agentNames: [],
              },
            ],
          })),
        },
      },
    })
    // The bulk grant is atomic: the whole request is rejected, so NOTHING landed.
    // No success toast, and no list-after-write (there is nothing new to reveal).
    const grant = vi.fn().mockRejectedValue(new Error('400 Bad Request: subjects_invalid'))
    const refreshGrants = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: false,
      },
      grant,
      refreshGrants,
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')

    const subjectPicker = await screen.findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    fireEvent.focus(subjectPicker)
    fireEvent.click(await screen.findByRole('option', { name: /Test Two/ }))
    fireEvent.click(await screen.findByRole('option', { name: /Test Three/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith(['user:user-2', 'user:user-3'], ['read'], true)
    )
    expect(grant).toHaveBeenCalledTimes(1)
    // The panel maps the verdict; no partial-success toast, no list-after-write.
    await screen.findByText('Some selected subjects are invalid and were rejected.')
    expect(refreshGrants).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalledWith(expect.stringContaining('Access granted'), 'success')
  })

  it('revokes a grant from the who-has-access list and toasts the outcome', async () => {
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
      },
    })
    const revokeGrant = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: false,
      },
      grants: [
        {
          id: 'grant-1',
          drive: 'main',
          resourceId: 'folder-1',
          subject: { type: 'host', id: '1st:mcp-host/chatllm' },
          permissions: ['read'],
          inherit: true,
        },
      ],
      revokeGrant,
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for chatllm' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))

    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('grant-1'))
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith('Access revoked for chatllm', 'success')
    )
  })

  it('changes an existing agent from Read to Editor using read/write only', async () => {
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
      },
    })
    const grant = vi.fn(async () => undefined)
    const refreshGrants = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read', 'write'],
        canCreateShare: false,
      },
      grants: [
        {
          id: 'grant-1',
          drive: 'main',
          resourceId: 'folder-1',
          subject: { type: 'host', id: '1st:mcp-host/chatllm' },
          permissions: ['read'],
          inherit: true,
        },
      ],
      grant,
      refreshGrants,
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')
    fireEvent.click(await screen.findByRole('button', { name: 'Access role for chatllm' }))
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))

    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith(['host:1st:mcp-host/chatllm'], ['read', 'write'], true)
    )
    expect(refreshGrants).toHaveBeenCalledTimes(1)
    expect(pushToast).toHaveBeenCalledWith('chatllm is now an Editor', 'success')
  })

  it('lists direct shares in the who-has-access list and revokes them', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: { listMine: vi.fn(async () => []) },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
      },
    })
    const revokeShare = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Team folder',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: true,
      },
      grants: [],
      shares: [
        {
          id: 'share-1',
          drive: 'main',
          resourceId: 'folder-1',
          subject: { type: 'user', id: 'user-9' },
          permissions: ['read'],
          includeDescendants: true,
        },
      ],
      revokeShare,
    })

    renderFilesPage(pushToast)
    await openManageDialog('Team folder')

    const shareRow = await screen.findByTestId('gfs-access-row-share-share-1')
    expect(shareRow.textContent).not.toContain('Includes contents')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for user-9' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))

    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('share-1'))
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith('Shared access revoked for user-9', 'success')
    )
  })

  it('renders the fail-closed state when GFS access is revoked and retries on demand', async () => {
    const retryAccess = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessState: 'revoked',
      retryAccess,
    })

    renderFilesPage()

    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    // Fail closed: no cached rows, no loading spinner — only the retry path.
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Shared with me' }).hasAttribute('disabled')).toBe(
      true
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry file access' }))
    expect(retryAccess).toHaveBeenCalledTimes(1)
  })

  it('closes the move dialog when authority is revoked mid-session', async () => {
    const moveResource = vi.fn(async () => ({}))
    const controllerState = {
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
          bytes: 0,
        },
      ],
      affordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: true,
        grantableBits: ['read'],
        canCreateShare: true,
      },
      moveResource,
    }
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // A fresh element per render pass: rerendering the identical element
    // reference would bail out and never observe the mutated mock.
    const makeElement = () => (
      <QueryClientProvider client={queryClient}>
        <FilesPage />
      </QueryClientProvider>
    )
    const { rerender } = render(makeElement())

    await chooseResourceAction('Product', 'Move to…')
    expect(await screen.findByRole('dialog', { name: 'Move folder Product' })).toBeTruthy()

    controllerState.accessState = 'revoked'
    rerender(makeElement())

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move folder Product' })).toBeNull()
    )
    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('refreshes server affordances whenever the manage dialog opens', async () => {
    const refreshAffordances = vi.fn(async () => undefined)
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Product',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      refreshAffordances,
    })

    renderFilesPage()
    await openManageDialog('Product')

    await waitFor(() => expect(refreshAffordances).toHaveBeenCalledTimes(1))
  })

  it('does not present stale read-only access while permissions are refreshing', async () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder',
        name: 'Product',
        kind: 'directory',
      },
      affordances: {
        held: ['read', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      loadingAffordances: true,
    })

    renderFilesPage()
    await openManageDialog('Product')

    expect(screen.getByText('Refreshing permissions…')).toBeTruthy()
    expect(screen.queryByText('Read-only access')).toBeNull()
  })

  it('downloads an accessible GFS file through the renderer download action', async () => {
    vi.useFakeTimers()
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const pushToast = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:gfs-download')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: { download },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: null,
          name: 'report.pdf',
          kind: 'file',
          path: '/report.pdf',
          version: 0,
          bytes: 3,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage(pushToast)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download report.pdf' }))
      await Promise.resolve()
    })

    expect(download).toHaveBeenCalledWith('gfs://main/file-1')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('Downloaded report.pdf', 'success')
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-download')
  })

  it('toasts a rate-limited download in read words, not permission words', async () => {
    const download = vi.fn(async () => {
      // The producer's exact shape. `appService.fetchBytes` throws
      // `gfs download failed: ${res.status}` and `surfaceGfsGrantError`
      // appends the window it vetted — so there is no inner colon and no
      // "Too Many Requests" on this leg. The old fixture classified the same,
      // which is why it went unnoticed, but a presentation test written to a
      // string the wire never carries proves nothing about the wire.
      throw new Error(
        "Error invoking remote method 'gfs:download': Error: " +
          'gfs download failed: 429 retryAfterSeconds=7'
      )
    })
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: null,
          name: 'report.pdf',
          kind: 'file',
          path: '/report.pdf',
          version: 0,
          bytes: 3,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage(pushToast)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download report.pdf' }))
      await Promise.resolve()
    })

    // Witness: the download really ran and really rejected, so the copy
    // assertions below describe a handled failure.
    expect(download).toHaveBeenCalledWith('gfs://main/file-1')
    expect(pushToast).toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
  })

  it('shows the document icon for txt, md, pdf, doc and docx files instead of the clip', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        'notes.txt',
        'readme.md',
        'report.pdf',
        'memo.doc',
        'brief.docx',
        'archive.zip',
      ].map((name, index) => ({
        resourceId: `file-${index}`,
        rid: `file-${index}`,
        gfsUri: `gfs://main/file-${index}`,
        drive: 'main',
        parentResourceId: null,
        name,
        kind: 'file',
        path: `/${name}`,
        version: 0,
        bytes: 3,
        sources: ['grant'],
        permissions: ['read'],
        coversDescendants: false,
      })),
    })

    const { container } = renderFilesPage()

    const documentRows = ['notes.txt', 'readme.md', 'report.pdf', 'memo.doc', 'brief.docx'].map(
      name => screen.getByRole('button', { name }).closest('.da-grid__row')
    )
    for (const row of documentRows) {
      const iconSvg = row?.querySelector('.da-gfs-list__icon svg')
      expect(iconSvg?.getAttribute('viewBox')).toBe('0 0 512 512')
      // The document glyph is outlined — paths carry fill="none" and a
      // real stroke width; the SVG itself must NOT receive the
      // data-solid="true" opt-in we use for filled icons.
      expect(iconSvg?.getAttribute('data-solid')).not.toBe('true')
      const path = iconSvg?.querySelector('path')
      expect(path?.getAttribute('fill')).toBe('none')
    }

    const clipRow = screen.getByRole('button', { name: 'archive.zip' }).closest('.da-grid__row')
    const clipIcon = clipRow?.querySelector('.da-gfs-list__icon svg')
    expect(clipIcon?.getAttribute('viewBox')).toBe('0 0 24 24')

    const listIconSvg = container.querySelectorAll('.da-gfs-list__icon svg')
    expect(
      [...listIconSvg].filter(svg => svg.getAttribute('viewBox') === '0 0 512 512')
    ).toHaveLength(5)
  })

  it('deletes a folder child from its row menu once delete affordances resolve', async () => {
    const pushToast = vi.fn()
    const deleteResource = vi.fn(async () => ({}))
    const setRowAffordancesResourceId = vi.fn()
    const child = {
      resourceId: 'child-1',
      rid: 'child-1',
      gfsUri: 'gfs://main/child-1',
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'notes.txt',
      kind: 'file',
      path: '/Product/notes.txt',
      version: 3,
      bytes: 12,
    }
    const controller = {
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
          bytes: 0,
        },
      ],
      items: [child],
      deleteResource,
      setRowAffordancesResourceId,
    }
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <FilesPage pushToast={pushToast} />
      </QueryClientProvider>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for notes.txt' }))
    })
    expect(setRowAffordancesResourceId).toHaveBeenCalledWith('child-1')
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()

    hookMock.useGfsBrowserController.mockReturnValue({
      ...controller,
      rowAffordancesResourceId: 'child-1',
      rowAffordances: {
        held: ['read', 'write', 'delete'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <FilesPage pushToast={pushToast} />
        </QueryClientProvider>
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    })
    const dialog = screen.getByRole('dialog', { name: 'Delete notes.txt?' })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    expect(deleteResource).toHaveBeenCalledWith('child-1', 3)
    expect(pushToast).toHaveBeenCalledWith('Deleted notes.txt', 'success')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves a folder child into another folder through the move dialog', async () => {
    const pushToast = vi.fn()
    const moveResource = vi.fn(async () => ({}))
    const listChildren = vi.fn(async () => ({
      items: [
        {
          resourceId: 'sub-1',
          rid: 'sub-1',
          gfsUri: 'gfs://main/sub-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Subfolder',
          kind: 'directory',
          path: '/Product/Subfolder',
          version: 6,
          bytes: 0,
        },
      ],
      nextCursor: null,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { listChildren } },
    })
    const child = {
      resourceId: 'child-1',
      rid: 'child-1',
      gfsUri: 'gfs://main/child-1',
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'notes.txt',
      kind: 'file',
      path: '/Product/notes.txt',
      version: 3,
      bytes: 12,
    }
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
          bytes: 0,
        },
      ],
      items: [child],
      moveResource,
    })

    renderFilesPage(pushToast)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for notes.txt' }))
    })
    // Move is not affordance-gated (authority is parent-relative, server-side).
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }))

    // The dialog starts at the current folder and lists its subfolders, but
    // never the moved resource itself.
    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    expect(await within(dialog).findByRole('button', { name: 'Subfolder' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'notes.txt' })).toBeNull()

    // The current parent is never preselected, and selecting it explicitly is
    // refused — that "move" is a server-accepted no-op that would toast
    // success while changing nothing.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Product' }))
    })
    const noOpButton = within(dialog).getByRole('button', {
      name: 'Move here (Product)',
    }) as HTMLButtonElement
    expect(noOpButton.disabled).toBe(true)
    expect(within(dialog).getByText(/is already in Product/)).toBeTruthy()

    // A real destination commits and toasts.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Subfolder' }))
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Subfolder)' }))
    })

    expect(moveResource).toHaveBeenCalledWith('child-1', 'sub-1', 3)
    expect(moveResource).toHaveBeenCalledTimes(1)
    expect(pushToast).toHaveBeenCalledWith('Moved notes.txt to Subfolder', 'success')
  })

  it('moves a dragged file onto a folder only after confirming destination write access', async () => {
    const pushToast = vi.fn()
    const moveResource = vi.fn(async () => ({}))
    const affordances = vi.fn(async () => ({
      held: ['read', 'write'],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { affordances } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'notes.txt',
          kind: 'file',
          path: '/Product/notes.txt',
          version: 3,
          bytes: 12,
        },
        {
          resourceId: 'archive-1',
          rid: 'archive-1',
          gfsUri: 'gfs://main/archive-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Archive',
          kind: 'directory',
          path: '/Product/Archive',
          version: 2,
          bytes: 0,
        },
      ],
      moveResource,
    })
    renderFilesPage(pushToast)

    const sourceRow = screen.getByRole('button', { name: 'Open notes.txt' })
    const destinationRow = screen.getByRole('button', { name: 'Open Archive' })
    const dataTransfer = {
      types: ['application/x-evenfire-gfs-resource'],
      files: [],
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
    }

    fireEvent.dragStart(sourceRow, { dataTransfer })
    fireEvent.dragEnter(destinationRow, { dataTransfer })

    await waitFor(() => {
      expect(affordances).toHaveBeenCalledWith('archive-1', 'main')
      expect(destinationRow.getAttribute('data-drop-target')).toBe('true')
    })
    fireEvent.dragOver(destinationRow, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')

    fireEvent.drop(destinationRow, { dataTransfer })

    await waitFor(() => {
      expect(moveResource).toHaveBeenCalledWith('file-1', 'archive-1', 3)
      expect(pushToast).toHaveBeenCalledWith('Moved notes.txt to Archive', 'success')
    })
  })

  it('rejects a file drop when the destination folder lacks write access', async () => {
    const pushToast = vi.fn()
    const moveResource = vi.fn(async () => ({}))
    const affordances = vi.fn(async () => ({
      held: ['read'],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { affordances } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'notes.txt',
          kind: 'file',
          path: '/Product/notes.txt',
          version: 3,
          bytes: 12,
        },
        {
          resourceId: 'private-1',
          rid: 'private-1',
          gfsUri: 'gfs://main/private-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Private',
          kind: 'directory',
          path: '/Product/Private',
          version: 2,
          bytes: 0,
        },
      ],
      moveResource,
    })
    renderFilesPage(pushToast)

    const sourceRow = screen.getByRole('button', { name: 'Open notes.txt' })
    const destinationRow = screen.getByRole('button', { name: 'Open Private' })
    const dataTransfer = {
      types: ['application/x-evenfire-gfs-resource'],
      files: [],
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
    }

    fireEvent.dragStart(sourceRow, { dataTransfer })
    fireEvent.dragEnter(destinationRow, { dataTransfer })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('private-1', 'main'))

    expect(destinationRow.getAttribute('data-drop-target')).toBeNull()
    expect(dataTransfer.dropEffect).toBe('none')
    fireEvent.drop(destinationRow, { dataTransfer })

    await waitFor(() => {
      expect(moveResource).not.toHaveBeenCalled()
      expect(pushToast).toHaveBeenCalledWith(
        'You can’t move files to Private because you don’t have write permission for this folder.',
        'error'
      )
    })
  })

  it('presents a rate-limited drop check in the shared read-plane words', async () => {
    // The affordances check is one of the nine methods `surfaceGfsGrantError`
    // wraps, so its rejection reaches the renderer as the IPC wrapper plus the
    // vetted markers. This toast rendered that raw. A 429 is a policy verdict,
    // not an authority failure, so it does not fail closed and the user really
    // does see this string.
    const pushToast = vi.fn()
    const moveResource = vi.fn(async () => ({}))
    const affordances = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'gfs:affordances': Error: 429 Too Many Requests: " +
          'Too Many Requests httpStatus=429 retryAfterSeconds=7'
      )
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { affordances } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'notes.txt',
          kind: 'file',
          path: '/Product/notes.txt',
          version: 3,
          bytes: 12,
        },
        {
          resourceId: 'private-1',
          rid: 'private-1',
          gfsUri: 'gfs://main/private-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Private',
          kind: 'directory',
          path: '/Product/Private',
          version: 2,
          bytes: 0,
        },
      ],
      moveResource,
    })
    renderFilesPage(pushToast)

    const sourceRow = screen.getByRole('button', { name: 'Open notes.txt' })
    const destinationRow = screen.getByRole('button', { name: 'Open Private' })
    const dataTransfer = {
      types: ['application/x-evenfire-gfs-resource'],
      files: [],
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
    }

    fireEvent.dragStart(sourceRow, { dataTransfer })
    fireEvent.dragEnter(destinationRow, { dataTransfer })
    // Liveness witness: the check really ran and really rejected, so the
    // absence assertions below describe a presented verdict rather than a drop
    // that never asked.
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('private-1', 'main'))

    fireEvent.drop(destinationRow, { dataTransfer })

    await waitFor(() => {
      expect(moveResource).not.toHaveBeenCalled()
      expect(pushToast).toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
    })
    const toasted = pushToast.mock.calls.map(([text]) => String(text)).join('\n')
    expect(toasted).not.toContain('httpStatus=')
    expect(toasted).not.toContain('retryAfterSeconds=')
    expect(toasted).not.toContain('Error invoking remote method')
  })

  it('renames a folder child from its row menu once write affordances resolve', async () => {
    const pushToast = vi.fn()
    const renameResource = vi.fn(async () => ({}))
    const setRowAffordancesResourceId = vi.fn()
    const child = {
      resourceId: 'child-1',
      rid: 'child-1',
      gfsUri: 'gfs://main/child-1',
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'notes.txt',
      kind: 'file',
      path: '/Product/notes.txt',
      version: 3,
      bytes: 12,
    }
    const controller = {
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      items: [child],
      renameResource,
      setRowAffordancesResourceId,
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const view = render(
      <QueryClientProvider client={queryClient}>
        <FilesPage pushToast={pushToast} />
      </QueryClientProvider>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for notes.txt' }))
    })
    // While the row affordances are unresolved, Rename is not offered.
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()

    hookMock.useGfsBrowserController.mockReturnValue({
      ...controller,
      rowAffordancesResourceId: 'child-1',
      rowAffordances: {
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <FilesPage pushToast={pushToast} />
        </QueryClientProvider>
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    })
    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    expect(screen.queryByRole('dialog', { name: 'Rename resource' })).toBeNull()
    await act(async () => {
      fireEvent.change(within(renameForm).getByLabelText('New name'), {
        target: { value: 'renamed-notes.txt' },
      })
      fireEvent.click(within(renameForm).getByRole('button', { name: 'Save name' }))
    })

    expect(renameResource).toHaveBeenCalledWith('child-1', 'renamed-notes.txt', 3)
    expect(pushToast).toHaveBeenCalledWith('Renamed to renamed-notes.txt', 'success')
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
  })

  it('offers row delete on shared resources that carry the delete permission', async () => {
    const pushToast = vi.fn()
    const deleteResource = vi.fn(async () => ({}))
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      deleteResource,
      accessibleResources: [
        {
          resourceId: 'shared-1',
          rid: 'shared-1',
          gfsUri: 'gfs://main/shared-1',
          drive: 'main',
          parentResourceId: null,
          name: 'shared-report.txt',
          kind: 'file',
          path: '/shared-report.txt',
          version: 2,
          bytes: 8,
          sources: ['grant'],
          permissions: ['read', 'delete'],
          coversDescendants: false,
        },
        {
          resourceId: 'shared-2',
          rid: 'shared-2',
          gfsUri: 'gfs://main/shared-2',
          drive: 'main',
          parentResourceId: null,
          name: 'readonly-notes.txt',
          kind: 'file',
          path: '/readonly-notes.txt',
          version: 1,
          bytes: 4,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage(pushToast)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for readonly-notes.txt' }))
    })
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for shared-report.txt' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    })
    const dialog = screen.getByRole('dialog', { name: 'Delete shared-report.txt?' })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    expect(deleteResource).toHaveBeenCalledWith('shared-1', 2)
    expect(pushToast).toHaveBeenCalledWith('Deleted shared-report.txt', 'success')
  })

  // Preview no longer opens a modal inside FilesPage (spec 18 §3.B.4): the page
  // resolves the file kind and hands a descriptor up through onOpenPreview so the
  // tab store opens/focuses a FilePreviewPage. These assert the observable
  // handoff (T4), not the byte fetch — the fetch now lives in Gfs*PreviewBody.
  const previewRow = (
    name: string,
    resourceId: string,
    bytes: number
  ): Record<string, unknown> => ({
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind: 'file',
    path: `/${name}`,
    version: 1,
    bytes,
    sources: ['grant'],
    permissions: ['read'],
    coversDescendants: false,
  })

  it('opens a preview tab for an image file instead of rendering a modal', () => {
    const download = vi.fn()
    Object.defineProperty(window, 'clerum', { configurable: true, value: { gfs: { download } } })
    const onOpenPreview = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [previewRow('diagram.PNG', 'image-1', 3)],
    })

    renderFilesPage(undefined, onOpenPreview)
    fireEvent.click(screen.getByRole('button', { name: 'diagram.PNG' }))

    expect(onOpenPreview).toHaveBeenCalledWith({
      gfsUri: 'gfs://main/image-1',
      kind: 'image',
      mimeType: 'image/png',
      name: 'diagram.PNG',
      bytes: 3,
    })
    // No modal, and FilesPage itself never fetches the bytes.
    expect(screen.queryByRole('dialog', { name: 'diagram.PNG' })).toBeNull()
    expect(download).not.toHaveBeenCalled()
  })

  it('opens a GFS URI from the modal and closes after a successful resolve', async () => {
    const openUri = vi.fn(async () => true)
    hookMock.useGfsBrowserController.mockReturnValue({ ...baseController(), openUri })
    renderFilesPage()

    expect(screen.queryByRole('button', { name: 'Open EvenDrive link' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Options for Shared with me' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open EvenDrive link' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open EvenDrive link' })
    fireEvent.change(within(dialog).getByLabelText('EvenDrive link'), {
      target: { value: 'gfs://main/resource-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(openUri).toHaveBeenCalledWith('gfs://main/resource-1'))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link' })).toBeNull()
    )
  })

  it('opens a preview tab for a markdown file (no mimeType in the descriptor)', () => {
    const onOpenPreview = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [previewRow('README.md', 'markdown-1', 12)],
    })
    renderFilesPage(undefined, onOpenPreview)
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))

    expect(onOpenPreview).toHaveBeenCalledWith({
      gfsUri: 'gfs://main/markdown-1',
      kind: 'markdown',
      name: 'README.md',
      bytes: 12,
    })
  })

  it('opens a preview tab for a video file with its detected mimeType', () => {
    const onOpenPreview = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [previewRow('demo.mp4', 'video-1', 3)],
    })

    renderFilesPage(undefined, onOpenPreview)
    fireEvent.click(screen.getByRole('button', { name: 'demo.mp4' }))

    expect(onOpenPreview).toHaveBeenCalledWith({
      gfsUri: 'gfs://main/video-1',
      kind: 'video',
      mimeType: 'video/mp4',
      name: 'demo.mp4',
      bytes: 3,
    })
  })

  it('downloads a previewable file when no preview surface is wired (fail-open to download)', async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const createObjectURL = vi.fn(() => 'blob:gfs-download')
    const revokeObjectURL = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    Object.defineProperty(window, 'clerum', { configurable: true, value: { gfs: { download } } })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [previewRow('diagram.PNG', 'image-1', 3)],
    })

    // No onOpenPreview: openFilePreview reports "not previewable" so the click
    // falls through to the download path instead of silently doing nothing.
    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'diagram.PNG' }))

    await waitFor(() => expect(download).toHaveBeenCalledWith('gfs://main/image-1'))
    expect(anchorClick).toHaveBeenCalled()
  })

  it('opens a preview tab from a resolved GFS link and closes the link dialog', async () => {
    const onOpenPreview = vi.fn()
    const resolvedFile: GfsCrumb = {
      resourceId: 'svg-1',
      gfsUri: 'gfs://main/svg-1',
      name: 'architecture.svg',
      kind: 'file',
      version: 1,
      bytes: 4,
    }
    let selectResolvedFile: (() => void) | undefined
    const openUri = vi.fn(async () => {
      selectResolvedFile?.()
      return resolvedFile
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download: vi.fn() } },
    })
    function useResolvedFileController() {
      const [crumbs, setCrumbs] = useState<GfsCrumb[]>([])
      selectResolvedFile = () => setCrumbs([resolvedFile])
      return {
        ...baseController(),
        crumbs,
        current: crumbs.at(-1) ?? null,
        openUri,
        restoreCrumbs: (nextCrumbs: GfsCrumb[]) => setCrumbs(nextCrumbs),
      }
    }
    hookMock.useGfsBrowserController.mockImplementation(useResolvedFileController)

    renderFilesPage(undefined, onOpenPreview)
    fireEvent.click(screen.getByRole('button', { name: 'Options for Shared with me' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open EvenDrive link' }))
    const linkDialog = await screen.findByRole('dialog', { name: 'Open EvenDrive link' })
    fireEvent.change(within(linkDialog).getByLabelText('EvenDrive link'), {
      target: { value: 'gfs://main/svg-1' },
    })
    fireEvent.click(within(linkDialog).getByRole('button', { name: 'Open' }))

    await waitFor(() =>
      expect(onOpenPreview).toHaveBeenCalledWith({
        gfsUri: 'gfs://main/svg-1',
        kind: 'image',
        mimeType: 'image/svg+xml',
        name: 'architecture.svg',
        bytes: 4,
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link' })).toBeNull()
    )
    expect(screen.getByRole('button', { name: 'Options for Shared with me' })).toBeTruthy()
  })

  it('navigates through breadcrumbs and resets to Shared with me', async () => {
    const goToCrumb = vi.fn()
    const reset = vi.fn()
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'nested-1',
        gfsUri: 'gfs://main/nested-1',
        name: 'Nested',
        kind: 'directory',
        version: 2,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
        },
        {
          resourceId: 'nested-1',
          gfsUri: 'gfs://main/nested-1',
          name: 'Nested',
          kind: 'directory',
          version: 2,
        },
      ],
      goToCrumb,
      reset,
    })
    renderFilesPage()

    const breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Product' }))
    expect(goToCrumb).toHaveBeenCalledWith(0)
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Shared with me' }))
    expect(reset).toHaveBeenCalledOnce()
  })

  it('mounts the ⋯ menu only on the active folder beside the breadcrumb, never on crumbs or the open file', async () => {
    const fullBits = {
      held: ['read', 'write', 'delete', 'manage_acl'],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    }
    const parentViewRowOptions = [
      'Share',
      'Open folder',
      'Open EvenDrive link',
      'Rename',
      'Move to…',
      'Delete',
    ]
    // The active folder is already open, so its menu is the row menu minus the
    // navigation item — exactly the pre-existing beside-the-breadcrumb menu.
    const activeFolderOptions = parentViewRowOptions.filter(option => option !== 'Open folder')

    // Phase 1 — the parent view: a fully-permissioned folder row's ⋯ menu.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
        },
      ],
      items: [
        {
          resourceId: 'folder-2',
          rid: 'folder-2',
          gfsUri: 'gfs://main/folder-2',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Team folder',
          kind: 'directory' as const,
          path: '/Product/Team folder',
          version: 2,
          bytes: 0,
        },
      ],
      rowAffordancesByResourceId: { 'folder-2': fullBits },
    })
    const parentView = renderFilesPage()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Team folder' }))
    })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(
      parentViewRowOptions
    )
    parentView.unmount()

    // Phase 2 — a file is open: no crumb (folder or file) carries a menu in
    // the breadcrumb, and the breadcrumb title row has none for the file.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'file-1',
        gfsUri: 'gfs://main/file-1',
        name: 'report.md',
        kind: 'file',
        version: 3,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
        },
        {
          resourceId: 'file-1',
          gfsUri: 'gfs://main/file-1',
          name: 'report.md',
          kind: 'file',
          version: 3,
        },
      ],
    })
    renderFilesPage()

    let breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
    let titleRow = document.querySelector<HTMLElement>('.da-gfs-drive__title-row')
    expect(within(breadcrumbs).queryByRole('button', { name: 'Options for Product' })).toBeNull()
    expect(within(breadcrumbs).queryByRole('button', { name: 'Options for report.md' })).toBeNull()
    expect(within(titleRow!).queryByRole('button', { name: 'Options for report.md' })).toBeNull()
    cleanup()

    // Phase 3 — a folder is open: exactly one ⋯ menu, for the ACTIVE folder,
    // sitting to the right of the breadcrumb (after the nav), while the
    // ancestor folder crumb stays plain.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-2',
        gfsUri: 'gfs://main/folder-2',
        name: 'Nested',
        kind: 'directory',
        version: 2,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
        },
        {
          resourceId: 'folder-2',
          gfsUri: 'gfs://main/folder-2',
          name: 'Nested',
          kind: 'directory',
          version: 2,
        },
      ],
      affordances: fullBits,
    })
    renderFilesPage()

    breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
    titleRow = document.querySelector<HTMLElement>('.da-gfs-drive__title-row')
    expect(within(breadcrumbs).queryByRole('button', { name: 'Options for Product' })).toBeNull()
    expect(within(breadcrumbs).queryByRole('button', { name: 'Options for Nested' })).toBeNull()

    const activeMenuTrigger = within(titleRow!).getByRole('button', { name: 'Options for Nested' })
    const activeMenuWrapper = activeMenuTrigger.closest('.da-gfs-resource-menu')
    expect(activeMenuWrapper?.previousElementSibling).toBe(breadcrumbs)

    await act(async () => {
      fireEvent.click(activeMenuTrigger)
    })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(
      activeFolderOptions
    )

    // "Open EvenDrive link" is present and opens the link dialog.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open EvenDrive link' }))
    expect(screen.getByRole('dialog', { name: 'Open EvenDrive link' })).toBeTruthy()
  })

  it('opens nested folders and exposes open and copy actions in the resource menu', async () => {
    const openChild = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const nestedFolder = {
      resourceId: 'nested-1',
      rid: 'nested-1',
      gfsUri: 'gfs://main/nested-1',
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'Nested',
      kind: 'directory' as const,
      path: '/Product/Nested',
      version: 2,
      bytes: 0,
    }
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      crumbs: [
        {
          resourceId: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          name: 'Product',
          kind: 'directory',
          version: 1,
        },
      ],
      items: [nestedFolder],
      rowAffordancesResourceId: 'nested-1',
      rowAffordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      openChild,
    })
    renderFilesPage()

    fireEvent.click(screen.getByRole('button', { name: 'Nested' }))
    expect(openChild).toHaveBeenCalledWith(nestedFolder)

    fireEvent.click(screen.getByRole('button', { name: 'Options for Nested' }))
    const shareItem = screen.getByRole('menuitem', { name: 'Share' })
    await waitFor(() => expect(document.activeElement).toBe(shareItem))
    fireEvent.keyDown(shareItem, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder' }))
    expect(openChild).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Options for Nested' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }))
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Share options for Nested' })).getByRole('menuitem', {
        name: 'Copy link',
      })
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gfs://main/nested-1'))
  })

  it('clears a cancelled create-folder draft before reopening the form', async () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      affordances: {
        held: ['read', 'write', 'manage_acl'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })
    renderFilesPage()

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'unfinished' } })
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Create folder' })).getByRole('button', {
        name: 'Cancel',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))

    expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('')
  })

  it('prefetches each folder child into the TanStack cache so the next click is instant', async () => {
    const listChildren = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          list: () => ({ items: [] }),
          download: vi.fn(),
          listChildren,
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      items: [
        {
          resourceId: 'folder-a',
          rid: 'folder-a',
          gfsUri: 'gfs://main/folder-a',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Alpha',
          kind: 'directory',
          path: '/Product/Alpha',
          version: 1,
          bytes: 0,
        },
        {
          resourceId: 'folder-b',
          rid: 'folder-b',
          gfsUri: 'gfs://main/folder-b',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'Beta',
          kind: 'directory',
          path: '/Product/Beta',
          version: 1,
          bytes: 0,
        },
        {
          resourceId: 'file-1',
          rid: 'file-1',
          gfsUri: 'gfs://main/file-1',
          drive: 'main',
          parentResourceId: 'folder-1',
          name: 'notes.md',
          kind: 'file',
          path: '/Product/notes.md',
          version: 1,
          bytes: 12,
        },
      ],
    })

    renderFilesPage()

    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
    expect(listChildren).toHaveBeenCalledWith('folder-a', 'main', undefined)
    expect(listChildren).toHaveBeenCalledWith('folder-b', 'main', undefined)
  })

  it('advances past subfolders whose prefetch failed instead of re-selecting them', async () => {
    // `data === undefined` is also true of a FAILED prefetch, so the cached-key
    // skip let the cap stall: the same first ten were re-selected on every
    // `items` change and the folders behind them were never warmed. The
    // existing cap test seeds only SUCCESS via `setQueryData`, which cannot
    // reach an error state, so nothing held this.
    //
    // The rate limit is the case that matters. Ten failures and a loadMore
    // page re-send the identical burst against the budget that just refused
    // it — the feedback loop the per-actor budget exists to stop.
    const doomed = new Set(
      Array.from({ length: 10 }, (_, index) => `folder-${String(index).padStart(2, '0')}`)
    )
    const listChildren = vi.fn(async (resourceId: string) => {
      if (doomed.has(resourceId)) {
        throw new Error('429 Too Many Requests: Too Many Requests retryAfterSeconds=7')
      }
      return { items: [], nextCursor: null }
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { list: () => ({ items: [] }), download: vi.fn(), listChildren } },
    })
    const makeFolder = (index: number) => ({
      resourceId: `folder-${String(index).padStart(2, '0')}`,
      rid: `folder-${index}`,
      gfsUri: `gfs://main/folder-${index}`,
      drive: 'main',
      parentResourceId: 'folder-1',
      name: `Folder ${index}`,
      kind: 'directory',
      path: `/Product/Folder ${index}`,
      version: 1,
      bytes: 0,
    })
    const current = {
      resourceId: 'folder-1',
      gfsUri: 'gfs://main/folder-1',
      name: 'Product',
      kind: 'directory',
      version: 1,
    }
    const showFolders = (count: number) => {
      hookMock.useGfsBrowserController.mockReturnValue({
        ...baseController(),
        current,
        items: Array.from({ length: count }, (_, index) => makeFolder(index)),
      })
    }

    showFolders(14)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // A fresh element per pass: React bails out of re-rendering a root given
    // the identical element reference, which would silently skip the effect
    // this test exists to re-trigger.
    const makeElement = () => (
      <QueryClientProvider client={queryClient}>
        <FilesPage />
      </QueryClientProvider>
    )
    const { rerender } = render(makeElement())

    // The first pass spends the whole cap on folders that all fail.
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(10))
    expect(listChildren.mock.calls.map(call => call[0])).toEqual([...doomed])

    // A loadMore page changes `items` and re-runs the effect — the exact
    // trigger the cached-key skip exists to survive.
    showFolders(16)
    rerender(makeElement())

    await waitFor(() => expect(listChildren.mock.calls.map(call => call[0])).toContain('folder-10'))
    const requested = listChildren.mock.calls.map(call => call[0])
    // The four already-visible folders plus the two the new page added: the
    // window really moved on rather than stalling on the failures.
    expect(requested.slice(10)).toEqual([
      'folder-10',
      'folder-11',
      'folder-12',
      'folder-13',
      'folder-14',
      'folder-15',
    ])
    // Each failed folder was asked for exactly once, never re-sent.
    doomed.forEach(resourceId => expect(requested.filter(id => id === resourceId)).toHaveLength(1))
    expect(listChildren).toHaveBeenCalledTimes(16)
  })

  it('prefetches only the first ten uncached subfolders, skipping those already in cache', async () => {
    // The mock carries the real signature so `calls.map(call => call[0])`
    // below is typed as the resource id, not as an empty tuple.
    const listChildren = vi.fn(async (_resourceId: string) => ({
      items: [],
      nextCursor: null,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { list: () => ({ items: [] }), download: vi.fn(), listChildren } },
    })
    const scope = 'env-1:user-1:team-1'
    const folders = Array.from({ length: 15 }, (_, index) => ({
      resourceId: `folder-${String(index).padStart(2, '0')}`,
      rid: `folder-${index}`,
      gfsUri: `gfs://main/folder-${index}`,
      drive: 'main',
      parentResourceId: 'folder-1',
      name: `Folder ${index}`,
      kind: 'directory',
      path: `/Product/Folder ${index}`,
      version: 1,
      bytes: 0,
    }))
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'folder-1',
        gfsUri: 'gfs://main/folder-1',
        name: 'Product',
        kind: 'directory',
        version: 1,
      },
      items: folders,
    })

    const cached = ['folder-02', 'folder-05', 'folder-09']
    // Scattered, not leading: a cap applied before the skip would still get
    // the first ten right if the cached ids were all at the front.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    cached.forEach(resourceId =>
      queryClient.setQueryData(desktopQueryKeys.gfsChildren(scope, resourceId, 'main'), {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [undefined],
      })
    )
    render(
      <QueryClientProvider client={queryClient}>
        <FilesPage />
      </QueryClientProvider>
    )

    // Positive, and the witness: the effect ran and sent exactly the cap.
    // Under production defaults `fetchInfiniteQuery` would serve the cached
    // pages without a request anyway; this harness runs at `staleTime: 0`, so
    // the explicit cached-key check is the only thing keeping those three out.
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(10))
    const requested = listChildren.mock.calls.map(call => call[0])
    cached.forEach(resourceId => expect(requested).not.toContain(resourceId))
    expect(requested).toEqual([
      'folder-00',
      'folder-01',
      'folder-03',
      'folder-04',
      'folder-06',
      'folder-07',
      'folder-08',
      'folder-10',
      'folder-11',
      'folder-12',
    ])
  })

  it('renders a rate-limited discovery failure as a card with a retry countdown', async () => {
    vi.useFakeTimers()
    const retryDiscovery = vi.fn()
    const rawMessage =
      "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=7'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: true,
      accessibleError: rawMessage,
      discoveryFailure: {
        kind: 'rate-limited',
        message: rawMessage,
        retryAvailableAt: Date.now() + 7_000,
      },
      retryDiscovery,
    })

    renderFilesPage()

    expect(screen.getByTestId('gfs-discovery-retry-seconds').textContent).toBe('7')
    // None of the three things the user saw during the incident.
    expect(screen.queryByText('Loading files…')).toBeNull()
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
    expect(screen.queryByText(/Automatic GFS discovery is not available/)).toBeNull()

    const disabledRetry = screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement
    expect(disabledRetry.disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000)
    })

    expect(screen.queryByTestId('gfs-discovery-retry-seconds')).toBeNull()
    const enabledRetry = screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement
    expect(enabledRetry.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(enabledRetry)
    })
    // Witness: the button is wired to the controller, not to a local no-op.
    expect(retryDiscovery).toHaveBeenCalledTimes(1)
  })

  it('keeps an already-loaded listing when the NEXT discovery page is rate limited', () => {
    // Discovery is an infinite query: TanStack populates `error` on a rejected
    // `fetchNextPage` while `data` still holds every page already fetched. The
    // card renders ahead of the grid, so without gating it on an empty listing
    // a `Load more` that hit the budget wiped out the rows the user already
    // had, to announce that a page they never saw had failed.
    const rawMessage =
      "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=120'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      // The first page succeeded, so the authority gate is closed and its rows
      // are on screen; only the follow-up page was refused.
      authorityPending: false,
      accessibleResources: [
        {
          resourceId: 'folder-1',
          rid: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          drive: 'main',
          parentResourceId: null,
          name: 'Product',
          kind: 'directory',
          path: '/Product',
          version: 1,
          bytes: 0,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: true,
        },
      ],
      hasMoreAccessible: true,
      accessibleError: rawMessage,
      discoveryFailure: {
        kind: 'rate-limited',
        message: rawMessage,
        retryAvailableAt: Date.now() + 120_000,
      },
    })

    renderFilesPage()

    // Witness: the loaded row really is rendered, so the absence of the card
    // below is about a listing that survived and not about a page that never
    // drew anything.
    expect(screen.getByRole('button', { name: 'Product' })).toBeTruthy()
    expect(screen.queryByTestId('gfs-discovery-retry-seconds')).toBeNull()
    // The failure is still surfaced — as the banner, not by razing the page.
    expect(screen.getByText(/Too many file requests/)).toBeTruthy()
  })

  it('leaves an unsupported discovery failure on the existing info notice, with no card', () => {
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleNotice:
        'Automatic GFS discovery is not available from this server yet. You can still open any GFS link you have.',
      discoveryFailure: {
        kind: 'unsupported',
        message: '404 Not Found: Not Found',
        retryAvailableAt: null,
      },
    })

    renderFilesPage()

    expect(screen.getByText(/Automatic GFS discovery is not available/)).toBeTruthy()
    expect(screen.queryByTestId('gfs-discovery-retry-seconds')).toBeNull()
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
  })

  it('shows a server-side discovery failure without the IPC plumbing around it', () => {
    // `kind: 'failed'` covers 5xx, network and timeout — everything that is
    // neither a 404 nor a rate limit. It reaches the same card, so the card's
    // body has to be presented rather than passed through: the raw value is an
    // Electron wrapper around the verdict, and the seam test in this PR asserts
    // that wrapper must never reach a user.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: true,
      accessibleError:
        "Error invoking remote method 'gfs:listAccessible': Error: 503 Service Unavailable: upstream_unreachable",
      discoveryFailure: {
        kind: 'failed',
        message:
          "Error invoking remote method 'gfs:listAccessible': Error: 503 Service Unavailable: upstream_unreachable",
        retryAvailableAt: null,
      },
    })

    renderFilesPage()

    // Liveness witness: the card really rendered, so the absence assertions
    // below describe a presented failure and not an unmounted branch.
    expect(screen.getByText('Could not load your files')).toBeTruthy()
    expect(screen.getByText(/503 Service Unavailable: upstream_unreachable/)).toBeTruthy()
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
    // No window was named, so nothing pretends to know one.
    expect(screen.queryByTestId('gfs-discovery-retry-seconds')).toBeNull()
    const retry = screen.getByRole('button', { name: /retry file listing/i }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
  })

  it('stops reporting the drive as busy once discovery has settled into a failure', () => {
    // authorityPending stays true after a 429 on purpose — a rate limit does
    // not re-prove the session — so aria-busy had to stop deriving from it
    // alone, or a screen reader announces a loading region that is showing a
    // settled error with a Retry button.
    const rawMessage =
      "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=7'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: true,
      accessibleError: rawMessage,
      discoveryFailure: {
        kind: 'rate-limited',
        message: rawMessage,
        retryAvailableAt: Date.now() + 7_000,
      },
    })

    renderFilesPage()

    const drive = screen.getByLabelText('EvenDrive browser')
    // Witness: this is the failure state, not a page that never rendered the
    // drive region at all.
    expect(screen.getByText('Too many file requests')).toBeTruthy()
    expect(drive.getAttribute('aria-busy')).toBe('false')
  })

  // The five fixtures above all set `authorityPending: true`, no rows and
  // `hasMoreAccessible: false` together, so nothing distinguishes the three
  // clauses of the card's guard: swapping the empty-listing test for either
  // sibling left the whole suite green. These two break that correlation, one
  // clause at a time, and each holds one clause on its own.
  it('keeps a loaded row while the authority gate is still pending', () => {
    // Rows present, gate pending, and no further page to fetch. Only
    // `visibleResources.length === 0` can decide here, so a guard rewritten to
    // read `authorityPending` (or `!hasMoreAccessible`) wipes out a listing the
    // user can see — the failure the empty-listing clause exists to prevent.
    const rawMessage =
      "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=7'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: true,
      hasMoreAccessible: false,
      accessibleResources: [
        {
          resourceId: 'folder-1',
          rid: 'folder-1',
          gfsUri: 'gfs://main/folder-1',
          drive: 'main',
          parentResourceId: null,
          name: 'Product',
          kind: 'directory',
          path: '/Product',
          version: 1,
          bytes: 0,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: true,
        },
      ],
      accessibleError: rawMessage,
      discoveryFailure: {
        kind: 'rate-limited',
        message: rawMessage,
        retryAvailableAt: Date.now() + 7_000,
      },
    })

    renderFilesPage()

    // Witness: the row is on screen, so the two absences below describe a
    // listing that survived rather than a page that drew nothing at all.
    expect(screen.getByRole('button', { name: 'Product' })).toBeTruthy()
    expect(screen.queryByTestId('gfs-discovery-retry-seconds')).toBeNull()
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
  })

  it('shows the card for an empty listing once the authority gate has closed', () => {
    // The mirror image: gate closed, no further page, and nothing to show. A
    // guard that read `authorityPending` instead would skip the card and leave
    // the user on "No shared files yet" for a listing that was refused.
    const rawMessage =
      "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=120'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: false,
      hasMoreAccessible: false,
      accessibleError: rawMessage,
      discoveryFailure: {
        kind: 'rate-limited',
        message: rawMessage,
        retryAvailableAt: Date.now() + 120_000,
      },
    })

    renderFilesPage()

    expect(screen.getByTestId('gfs-discovery-retry-seconds').textContent).toBe('120')
    expect(screen.queryByText('No shared files yet')).toBeNull()
  })

  it('answers a 404 discovery failure with its own empty state, never a loader', () => {
    // The original incident's symptom through a different door. An older
    // control-api has no `listAccessible`, so the 404 leaves `authorityPending`
    // true forever — correctly, since nothing re-proved the session — and the
    // page used to spin "Loading files…" underneath the very notice explaining
    // that discovery is unavailable. Two contradictory claims at once.
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: true,
      accessibleNotice:
        'Automatic GFS discovery is not available from this server yet. You can still open any GFS link you have.',
      discoveryFailure: {
        kind: 'unsupported',
        message: '404 Not Found: Not Found',
        retryAvailableAt: null,
      },
    })

    renderFilesPage()

    // Witness: the settled state really rendered.
    expect(screen.getByText('Files cannot be listed here')).toBeTruthy()
    expect(screen.getByText(/That does not mean you have none/)).toBeTruthy()
    expect(screen.queryByText('Loading files…')).toBeNull()
    // No Retry: the endpoint does not appear because a button was pressed.
    expect(screen.queryByRole('button', { name: /retry file listing/i })).toBeNull()
    // The copy that would assert an empty library must not be the one shown.
    expect(screen.queryByText('No shared files yet')).toBeNull()
  })

  it('reveals a file opened by link while discovery is still rate limited', () => {
    // Opening a `gfs://` link does not go through discovery, so a 429 there has
    // no bearing on whether the resolved file can be shown. It was shown only
    // as a spinner, because the page called the pending authority gate a load
    // in progress and the loader renders ahead of the file.
    const rawMessage =
      "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=7'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      authorityPending: true,
      current: {
        resourceId: 'file-1',
        gfsUri: 'gfs://main/file-1',
        name: 'quarterly.pdf',
        kind: 'file',
        version: 1,
        bytes: 2048,
      },
      crumbs: [
        {
          resourceId: 'file-1',
          gfsUri: 'gfs://main/file-1',
          name: 'quarterly.pdf',
          kind: 'file',
        },
      ],
      accessibleError: rawMessage,
      discoveryFailure: {
        kind: 'rate-limited',
        message: rawMessage,
        retryAvailableAt: Date.now() + 7_000,
      },
    })

    renderFilesPage()

    // The heading, not the breadcrumb: the breadcrumb renders above the
    // loader and would be present even while the spinner hid the file, so
    // only the heading proves the file view itself was reached.
    expect(screen.getByRole('heading', { name: 'quarterly.pdf' })).toBeTruthy()
    expect(screen.queryByText('Loading files…')).toBeNull()
    // The discovery failure belongs to the root listing, not to this file, so
    // it must not take the surface over either.
    expect(screen.queryByText('Too many file requests')).toBeNull()
  })

  it('answers a rate-limited folder listing with the card, not an empty folder', async () => {
    vi.useFakeTimers()
    const retryChildren = vi.fn()
    const rawMessage =
      "Error invoking remote method 'gfs:listChildren': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=7'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      items: [],
      error: rawMessage,
      errorUpdatedAt: Date.now(),
      retryChildren,
    })

    renderFilesPage()

    // "This folder is empty" states as fact the one thing the refused request
    // could not establish, and offered nothing to retry.
    expect(screen.queryByText('This folder is empty')).toBeNull()
    expect(screen.getByText('Too many file requests')).toBeTruthy()
    expect(screen.getByTestId('gfs-discovery-retry-seconds').textContent).toBe('7')
    // The raw channel name stays out of the user's way on this plane too.
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000)
    })
    const retry = screen.getByRole('button', { name: /retry file listing/i }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(retry)
    })
    // Witness: the button retries the query that actually failed — the children
    // listing — and not discovery, which was never asked anything here.
    expect(retryChildren).toHaveBeenCalledTimes(1)
  })

  it('keeps a loaded folder listing when only its next page was refused', () => {
    // The folder-plane sibling of the `Load more` case: rows already fetched
    // must not be razed to report that the page behind them failed.
    const rawMessage =
      "Error invoking remote method 'gfs:listChildren': Error: 429 Too Many Requests: " +
      'Too Many Requests retryAfterSeconds=7'
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      current: {
        resourceId: 'parent-1',
        gfsUri: 'gfs://main/parent-1',
        name: 'Workspace',
        kind: 'directory',
        version: 1,
        bytes: 0,
      },
      items: [
        {
          resourceId: 'file-child',
          rid: 'file-child',
          gfsUri: 'gfs://main/file-child',
          drive: 'main',
          parentResourceId: 'parent-1',
          name: 'notes.txt',
          kind: 'file',
          path: '/notes.txt',
          version: 1,
          bytes: 12,
        },
      ],
      error: rawMessage,
      errorUpdatedAt: Date.now(),
    })

    renderFilesPage()

    // Witness: the row survived the failure.
    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(screen.queryByTestId('gfs-discovery-retry-seconds')).toBeNull()
    // Still surfaced, as the banner — and presented, not as the IPC wrapper.
    expect(screen.getByText(/Too many file requests — try again in 7s\./)).toBeTruthy()
  })
})
