// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES } from '@constants/gfsFileUpload'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
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
  }
}

function renderFilesPage(pushToast?: (message: string, tone: Tone) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <FilesPage pushToast={pushToast} />
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
        'Automatic GFS discovery is not available in this desktop runtime. You can still open any GFS link you have.',
    })

    renderFilesPage()

    const notice = screen.getByText(/Automatic GFS discovery is not available/i)
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
    expect(screen.queryByText(/Automatic GFS discovery is not available/i)).toBeNull()
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

    const row = screen.getByRole('button', { name: 'Open report.txt' }).closest('.da-grid__row')
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

    const folderRow = screen.getByRole('button', { name: 'Open Assets' }).closest('.da-grid__row')
    const fileRow = screen.getByRole('button', { name: 'Open report.txt' }).closest('.da-grid__row')
    const readonlyRow = screen
      .getByRole('button', { name: 'Open readonly.txt' })
      .closest('.da-grid__row')
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
    expect(screen.queryByRole('button', { name: 'Open GFS link' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Options for Team folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open GFS link' }))
    expect(screen.getByRole('dialog', { name: 'Open GFS link' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close GFS link dialog' }))

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
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
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
    fireEvent.drop(screen.getByRole('region', { name: 'Global File System browser' }), {
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
    fireEvent.drop(screen.getByRole('region', { name: 'Global File System browser' }), {
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
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
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
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
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
    fireEvent.drop(screen.getByRole('region', { name: 'Global File System browser' }), {
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
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
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
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
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

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke access for chatllm' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Revoke shared access for user-9' }))

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

  // R4 spec §1 — on revocation, every local surface that could show or act on
  // stale GFS data must close. Here: an open image preview (already-fetched
  // bytes) and an open Move dialog.
  it('closes an open preview when authority is revoked mid-session', async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const createObjectURL = vi.fn(() => 'blob:gfs-image-preview')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })
    const controllerState = {
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'image-1',
          rid: 'image-1',
          gfsUri: 'gfs://main/image-1',
          drive: 'main',
          parentResourceId: null,
          name: 'secret.PNG',
          kind: 'file',
          path: '/secret.PNG',
          version: 1,
          bytes: 3,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
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

    fireEvent.click(screen.getByRole('button', { name: 'secret.PNG' }))
    expect(await screen.findByRole('dialog', { name: 'secret.PNG' })).toBeTruthy()

    controllerState.accessState = 'revoked'
    rerender(makeElement())

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'secret.PNG' })).toBeNull())
    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
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

  it('previews an image file in a closable modal without downloading it to disk', async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const createObjectURL = vi.fn(() => 'blob:gfs-image-preview')
    const revokeObjectURL = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
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
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'image-1',
          rid: 'image-1',
          gfsUri: 'gfs://main/image-1',
          drive: 'main',
          parentResourceId: null,
          name: 'diagram.PNG',
          kind: 'file',
          path: '/diagram.PNG',
          version: 1,
          bytes: 3,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage()
    expect(download).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'diagram.PNG' }))

    const dialog = await screen.findByRole('dialog', { name: 'diagram.PNG' })
    await waitFor(() => expect(within(dialog).getByAltText('Preview of diagram.PNG')).toBeTruthy())
    const copyButton = within(dialog).getByRole('button', { name: /Copy image to clipboard/i })
    expect(copyButton.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(copyButton.querySelector('path')?.getAttribute('d')).toBe('M0 0h24v24H0z')
    expect(download).toHaveBeenCalledWith('gfs://main/image-1')
    expect(download).toHaveBeenCalledTimes(1)
    expect(anchorClick).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'diagram.PNG' })).toBeNull())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-image-preview')
  })

  it('copies markdown source to the clipboard via the preview header button', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { ...(navigator.clipboard ?? {}), writeText },
    })

    const markdown = '# Hello\n\nGreetings.'
    const download = vi.fn(async () => ({
      bytes: new TextEncoder().encode(markdown).buffer,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'markdown-2',
          rid: 'markdown-2',
          gfsUri: 'gfs://main/markdown-2',
          drive: 'main',
          parentResourceId: null,
          name: 'README.md',
          kind: 'file',
          path: '/README.md',
          version: 1,
          bytes: markdown.length,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))
    const dialog = await screen.findByRole('dialog', { name: 'README.md' })

    const copyButton = within(dialog).getByRole('button', {
      name: /Copy preview contents to clipboard/i,
    })
    expect(copyButton.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(copyButton.querySelector('path')?.getAttribute('d')).toBe('M0 0h24v24H0z')
    fireEvent.click(copyButton)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
  })

  it('renders a .txt file as plain text inside the preview dialog', async () => {
    const download = vi.fn(async () => ({
      bytes: new TextEncoder().encode('line one\nline two\twith tab').buffer,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'text-1',
          rid: 'text-1',
          gfsUri: 'gfs://main/text-1',
          drive: 'main',
          parentResourceId: null,
          name: 'notes.txt',
          kind: 'file',
          path: '/notes.txt',
          version: 1,
          bytes: 26,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'notes.txt' }))
    const dialog = await screen.findByRole('dialog', { name: 'notes.txt' })
    const pre = await within(dialog).findByText(/line one/)
    expect(pre.tagName).toBe('PRE')
    expect(pre.textContent).toContain('line two\twith tab')
  })

  it('previews a video file in a closable HTML5 video dialog', async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const createObjectURL = vi.fn(() => 'blob:gfs-video-preview')
    const revokeObjectURL = vi.fn()
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
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'video-1',
          rid: 'video-1',
          gfsUri: 'gfs://main/video-1',
          drive: 'main',
          parentResourceId: null,
          name: 'demo.mp4',
          kind: 'file',
          path: '/demo.mp4',
          version: 1,
          bytes: 3,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'demo.mp4' }))

    const dialog = await screen.findByRole('dialog', { name: 'demo.mp4' })
    const video = await within(dialog).findByLabelText('Video preview of demo.mp4')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('controls')).not.toBeNull()
    expect(video.getAttribute('src')).toBe('blob:gfs-video-preview')
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'video/mp4' }))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close video preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'demo.mp4' })).toBeNull())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-video-preview')
  })

  it('previews Markdown files with safe vanilla rendering', async () => {
    const markdown =
      '# Project guide\n\nUse **safe rendering**.\n\n1. First\n2. Second\n\n[Unsafe](javascript:alert)\n\n<script>alert("no")</script>'
    const download = vi.fn(async () => ({ bytes: new TextEncoder().encode(markdown).buffer }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'markdown-1',
          rid: 'markdown-1',
          gfsUri: 'gfs://main/markdown-1',
          drive: 'main',
          parentResourceId: null,
          name: 'README.md',
          kind: 'file',
          path: '/README.md',
          version: 1,
          bytes: markdown.length,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))

    const dialog = await screen.findByRole('dialog', { name: 'README.md' })
    expect(
      await within(dialog).findByRole('heading', { name: 'Project guide', level: 1 })
    ).toBeTruthy()
    expect(within(dialog).getByText('safe rendering').tagName).toBe('STRONG')
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
    expect(within(dialog).getByText('Unsafe').closest('a')).toBeNull()
    expect(dialog.querySelector('script')).toBeNull()
    expect(download).toHaveBeenCalledWith('gfs://main/markdown-1')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'README.md' })).toBeNull())
  })

  it('rejects oversized previews from metadata before downloading them', async () => {
    const download = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      ...baseController(),
      accessibleResources: [
        {
          resourceId: 'large-image',
          rid: 'large-image',
          gfsUri: 'gfs://main/large-image',
          drive: 'main',
          parentResourceId: null,
          name: 'oversized.png',
          kind: 'file',
          path: '/oversized.png',
          version: 1,
          bytes: GFS_IMAGE_PREVIEW_MAX_BYTES + 1,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
        {
          resourceId: 'large-markdown',
          rid: 'large-markdown',
          gfsUri: 'gfs://main/large-markdown',
          drive: 'main',
          parentResourceId: null,
          name: 'oversized.md',
          kind: 'file',
          path: '/oversized.md',
          version: 1,
          bytes: GFS_MARKDOWN_PREVIEW_MAX_BYTES + 1,
          sources: ['grant'],
          permissions: ['read'],
          coversDescendants: false,
        },
      ],
    })

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'oversized.png' }))
    let dialog = await screen.findByRole('dialog', { name: 'oversized.png' })
    expect(await within(dialog).findByText(/Image previews are limited to 10 MB/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }))

    fireEvent.click(screen.getByRole('button', { name: 'oversized.md' }))
    dialog = await screen.findByRole('dialog', { name: 'oversized.md' })
    expect(await within(dialog).findByText(/Markdown previews are limited to 2 MB/)).toBeTruthy()
    expect(download).not.toHaveBeenCalled()
  })

  it('opens a GFS URI from the modal and closes after a successful resolve', async () => {
    const openUri = vi.fn(async () => true)
    hookMock.useGfsBrowserController.mockReturnValue({ ...baseController(), openUri })
    renderFilesPage()

    expect(screen.queryByRole('button', { name: 'Open GFS link' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Options for Shared with me' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open GFS link' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open GFS link' })
    fireEvent.change(within(dialog).getByLabelText('gfs URI'), {
      target: { value: 'gfs://main/resource-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(openUri).toHaveBeenCalledWith('gfs://main/resource-1'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Open GFS link' })).toBeNull())
  })

  it('opens an SVG GFS link in preview without leaving the browser on a file-only route', async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([60, 115, 118, 103]).buffer }))
    const createObjectURL = vi.fn(() => 'blob:gfs-svg-preview')
    const revokeObjectURL = vi.fn()
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
      value: { gfs: { download } },
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

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'Options for Shared with me' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open GFS link' }))
    const linkDialog = await screen.findByRole('dialog', { name: 'Open GFS link' })
    fireEvent.change(within(linkDialog).getByLabelText('gfs URI'), {
      target: { value: 'gfs://main/svg-1' },
    })
    fireEvent.click(within(linkDialog).getByRole('button', { name: 'Open' }))

    const preview = await screen.findByRole('dialog', { name: 'architecture.svg' })
    await waitFor(() =>
      expect(within(preview).getByAltText('Preview of architecture.svg')).toBeTruthy()
    )
    expect(download).toHaveBeenCalledWith('gfs://main/svg-1')
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/svg+xml' }))
    expect(screen.queryByRole('dialog', { name: 'Open GFS link' })).toBeNull()

    fireEvent.click(within(preview).getByRole('button', { name: 'Close image preview' }))
    expect(screen.queryByRole('heading', { name: 'architecture.svg' })).toBeNull()
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
})
