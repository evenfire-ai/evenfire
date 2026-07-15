// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    accessibleResources: [],
    items: [],
    affordances: null,
    affordancesError: null,
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
    grant: vi.fn(),
    createShare: vi.fn(),
    createFolder: vi.fn(),
    createFile: vi.fn(),
    replaceFile: vi.fn(),
    renameResource: vi.fn(),
    deleteResource: vi.fn(),
    mutating: false,
    reset: vi.fn(),
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage' }))
  })
}

describe('FilesPage', () => {
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
        held: ['read', 'write', 'delete'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      createFolder,
      renameResource,
      deleteResource,
    })

    renderFilesPage()

    await openManageDialog('Team folder')
    expect(screen.getByText(/raw files around 110 MB/i)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /new folder/i }))
    })
    const createFolderForm = screen.getByRole('form', { name: 'Create folder' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'new-folder' } })
      fireEvent.click(createFolderForm.querySelector('button[type="submit"]')!)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /rename/i }))
    })
    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'renamed' } })
      fireEvent.click(renameForm.querySelector('button[type="submit"]')!)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    })
    const deleteDialog = screen.getByRole('alertdialog', { name: 'Delete resource' })
    await act(async () => {
      fireEvent.click(deleteDialog.querySelector('button')!)
    })

    expect(createFolder).toHaveBeenCalledWith('new-folder')
    expect(renameResource).toHaveBeenCalledWith('folder-1', 'renamed', 7)
    expect(deleteResource).toHaveBeenCalledWith('folder-1', 7)
  })

  it('shortens oversized file names before uploading through Desktop GFS', async () => {
    const createFile = vi.fn(async (_name: string, _encodedData: string) => undefined)
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
      createFile,
    })

    renderFilesPage(pushToast)

    await openManageDialog('Team folder')
    const rawName = `quarterly-${'very-long-'.repeat(32)}report.txt`
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Upload file'), {
        target: {
          files: [new File(['desktop upload'], rawName, { type: 'text/plain' })],
        },
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(createFile).toHaveBeenCalled())
    const uploadCall = createFile.mock.calls[0]
    expect(uploadCall).toBeTruthy()
    const [uploadedName, encodedData] = uploadCall!
    expect(uploadedName).not.toBe(rawName)
    expect(uploadedName).toHaveLength(255)
    expect(uploadedName).toMatch(/-[0-9a-f]{12}\.txt$/)
    expect(encodedData).toBe('ZGVza3RvcCB1cGxvYWQ=')
    expect(pushToast).toHaveBeenCalledWith(`Uploaded ${uploadedName}`, 'success')
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
        held: ['read', 'delete'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      deleteResource,
    })

    renderFilesPage(pushToast)

    await openManageDialog('Team folder')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    })
    const deleteDialog = screen.getByRole('alertdialog', { name: 'Delete resource' })
    await act(async () => {
      fireEvent.click(deleteDialog.querySelector('button')!)
      await Promise.resolve()
    })

    expect(deleteResource).toHaveBeenCalledWith('folder-1', 7)
    expect(pushToast).toHaveBeenCalledWith('not_empty: folder has children', 'error')
    expect(screen.getByRole('alertdialog', { name: 'Delete resource' })).toBeTruthy()
  })

  it('surfaces stale replace and rename precondition failures for the current file', async () => {
    const replaceFile = vi.fn(async () => {
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
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      replaceFile,
      renameResource,
    })

    renderFilesPage(pushToast)

    await openManageDialog('report.txt')
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Replace file'), {
        target: {
          files: [new File(['replacement'], 'report.txt', { type: 'text/plain' })],
        },
      })
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /rename/i }))
    })
    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New name'), {
        target: { value: 'report-renamed.txt' },
      })
      fireEvent.click(renameForm.querySelector('button[type="submit"]')!)
      await Promise.resolve()
    })

    expect(replaceFile).toHaveBeenCalledWith('file-1', 'cmVwbGFjZW1lbnQ=', 7)
    expect(renameResource).toHaveBeenCalledWith('file-1', 'report-renamed.txt', 7)
    expect(pushToast).toHaveBeenCalledWith('precondition_failed: stale file version', 'error')
    expect(pushToast).toHaveBeenCalledWith('precondition_failed: stale resource version', 'error')
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

    const subjectSelect = await screen.findByLabelText('subject')
    await waitFor(() => expect(subjectSelect).toHaveProperty('disabled', false))
    fireEvent.click(subjectSelect)
    expect(await screen.findByRole('option', { name: 'Test Two (test2@clerum.io)' })).toBeTruthy()
    expect(screen.queryByPlaceholderText(/uuid/i)).toBeNull()
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
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.pdf' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))
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

  it('opens a GFS URI from the modal and closes after a successful resolve', async () => {
    const openUri = vi.fn(async () => true)
    hookMock.useGfsBrowserController.mockReturnValue({ ...baseController(), openUri })
    renderFilesPage()

    fireEvent.click(screen.getByRole('button', { name: 'Open GFS link' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open GFS link' })
    fireEvent.change(within(dialog).getByLabelText('gfs URI'), {
      target: { value: 'gfs://main/resource-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(openUri).toHaveBeenCalledWith('gfs://main/resource-1'))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open GFS link' })).toBeNull()
    )
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
      openChild,
    })
    renderFilesPage()

    fireEvent.click(screen.getByRole('button', { name: 'Nested' }))
    expect(openChild).toHaveBeenCalledWith(nestedFolder)

    fireEvent.click(screen.getByRole('button', { name: 'Options for Nested' }))
    const manageItem = screen.getByRole('menuitem', { name: 'Manage' })
    await waitFor(() => expect(document.activeElement).toBe(manageItem))
    fireEvent.keyDown(manageItem, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder' }))
    expect(openChild).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Options for Nested' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy GFS link' }))
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
        held: ['read', 'write'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
    })
    renderFilesPage()

    await openManageDialog('Product')
    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'unfinished' } })
    fireEvent.click(within(screen.getByRole('form', { name: 'Create folder' })).getByRole('button', {
      name: 'Cancel',
    }))
    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))

    expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('')
  })
})
