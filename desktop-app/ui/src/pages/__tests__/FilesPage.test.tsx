// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GFS_FILE_UPLOAD_MAX_BYTES } from '@constants/gfsFileUpload'
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
    accessibleResources: [],
    items: [],
    affordances: null,
    affordancesError: null,
    loadingAffordances: false,
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
    grants: [],
    grantsError: null,
    loadingGrants: false,
    refreshGrants: vi.fn(),
    revokeGrant: vi.fn(),
    revoking: false,
    createShare: vi.fn(),
    createFolder: vi.fn(),
    createFile: vi.fn(),
    replaceFile: vi.fn(),
    renameResource: vi.fn(),
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage' }))
  })
}

async function chooseManageAction(resourceName: string, actionName: string) {
  const dialog = screen.getByRole('dialog', { name: new RegExp(`Manage .* ${resourceName}`) })
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: `Options for ${resourceName}` }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: actionName }))
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
    expect(screen.queryByText('Manage folder')).toBeNull()
    await chooseManageAction('Team folder', 'New folder')
    const createFolderForm = screen.getByRole('form', { name: 'Create folder' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'new-folder' } })
      fireEvent.click(createFolderForm.querySelector('button[type="submit"]')!)
    })

    await chooseManageAction('Team folder', 'Rename')
    const renameForm = screen.getByRole('form', { name: 'Rename resource' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'renamed' } })
      fireEvent.click(renameForm.querySelector('button[type="submit"]')!)
    })

    await chooseManageAction('Team folder', 'Delete')
    const deleteDialog = screen.getByRole('alertdialog', { name: 'Delete resource' })
    await act(async () => {
      fireEvent.click(deleteDialog.querySelector('button')!)
    })

    expect(createFolder).toHaveBeenCalledWith('new-folder')
    expect(renameResource).toHaveBeenCalledWith('folder-1', 'renamed', 7)
    expect(deleteResource).toHaveBeenCalledWith('folder-1', 7)
  })

  it('shortens oversized file names before uploading through Desktop GFS', async () => {
    const createFile = vi.fn(
      async (_parentResourceId: string, _name: string, _encodedData: string) => undefined
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
    const [parentResourceId, uploadedName, encodedData] = uploadCall!
    expect(parentResourceId).toBe('folder-1')
    expect(uploadedName).not.toBe(rawName)
    expect(uploadedName).toHaveLength(255)
    expect(uploadedName).toMatch(/-[0-9a-f]{12}\.txt$/)
    expect(encodedData).toBe('ZGVza3RvcCB1cGxvYWQ=')
    expect(pushToast).toHaveBeenCalledWith(`Uploaded ${uploadedName}`, 'success')
  })

  it('uploads dropped images and Markdown files into the open writable folder', async () => {
    const createFile = vi.fn(
      async (_parentResourceId: string, _name: string, _encodedData: string) => undefined
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
      createFile,
    })

    renderFilesPage(pushToast)
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    const image = new File(['desktop image'], 'diagram.png', { type: 'image/png' })
    const markdown = new File(['# Desktop notes'], 'notes.markdown', { type: 'text/markdown' })
    const dataTransfer = { dropEffect: 'none', files: [image, markdown], types: ['Files'] }

    fireEvent.dragEnter(browser, { dataTransfer })
    const dropStatus = screen.getByRole('status')
    expect(dropStatus.textContent).toContain(
      'Drop images or Markdown files to upload to Team folder'
    )
    expect(dropStatus.className).toContain('composer-drop-overlay')

    await act(async () => {
      fireEvent.drop(browser, { dataTransfer })
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(createFile).toHaveBeenCalledWith('folder-1', 'diagram.png', 'ZGVza3RvcCBpbWFnZQ==')
    )
    expect(createFile).toHaveBeenCalledWith('folder-1', 'notes.markdown', 'IyBEZXNrdG9wIG5vdGVz')
    expect(pushToast).toHaveBeenCalledWith('Uploaded diagram.png', 'success')
    expect(pushToast).toHaveBeenCalledWith('Uploaded notes.markdown', 'success')
  })

  it('allows a Markdown drop to retry immediately after an upload failure', async () => {
    const createFile = vi
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
      createFile,
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

    await waitFor(() => expect(createFile).toHaveBeenCalledTimes(2))
    expect(createFile).toHaveBeenLastCalledWith('folder-1', 'retry.md', 'IyBSZXRyeQ==')
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
    const createFile = vi.fn((_parentResourceId: string, _name: string, _encodedData: string) =>
      createFile.mock.calls.length === 1
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
        createFile,
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
    await waitFor(() => expect(createFile).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Shared folder' }))
    releaseFirstUpload?.()

    await waitFor(() => expect(createFile).toHaveBeenCalledTimes(2))
    expect(createFile.mock.calls.map(call => call[0])).toEqual(['folder-a', 'folder-a'])
  })

  it('rejects oversized dropped files before reading or uploading them', async () => {
    const createFile = vi.fn()
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
    const oversized = new File(['small fixture'], 'oversized.md', { type: 'text/markdown' })
    Object.defineProperty(oversized, 'size', { value: GFS_FILE_UPLOAD_MAX_BYTES + 1 })
    const arrayBuffer = vi.spyOn(oversized, 'arrayBuffer')

    renderFilesPage(pushToast)
    fireEvent.drop(screen.getByRole('region', { name: 'Global File System browser' }), {
      dataTransfer: { dropEffect: 'none', files: [oversized], types: ['Files'] },
    })

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith('GFS uploads are limited to 10 MB per file.', 'error')
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(createFile).not.toHaveBeenCalled()
  })

  it('keeps cached write access available while affordances refresh', async () => {
    const createFile = vi.fn(async () => undefined)
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
      createFile,
    })

    renderFilesPage()
    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    const dataTransfer = {
      dropEffect: 'none',
      files: [new File(['# Notes'], 'notes.md', { type: 'text/markdown' })],
      types: ['Files'],
    }
    fireEvent.dragEnter(browser, { dataTransfer })

    expect(screen.getByRole('status').textContent).toContain(
      'Drop images or Markdown files to upload to Team folder'
    )
    fireEvent.drop(browser, { dataTransfer })
    await waitFor(() =>
      expect(createFile).toHaveBeenCalledWith('folder-1', 'notes.md', 'IyBOb3Rlcw==')
    )
  })

  it('explains why dropped preview files cannot be uploaded without folder write permission', () => {
    const createFile = vi.fn()
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
      createFile,
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

    expect(createFile).not.toHaveBeenCalled()
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
        held: ['read', 'delete'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      },
      deleteResource,
    })

    renderFilesPage(pushToast)

    await openManageDialog('Team folder')
    await chooseManageAction('Team folder', 'Delete')
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
    await chooseManageAction('report.txt', 'Rename')
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
    expect(
      screen.getByRole('checkbox', { name: 'Include contents of this folder' })
    ).toHaveProperty('checked', true)
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
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

    // handleGrant issues the grant then MUST list-after-write (the grant PUT
    // returns no ids). Deleting `await ctrl.refreshGrants()` must fail here.
    await waitFor(() => expect(grant).toHaveBeenCalledWith(['user:user-2'], ['read'], true))
    await waitFor(() => expect(refreshGrants).toHaveBeenCalledTimes(1))
    expect(pushToast).toHaveBeenCalledWith('Access granted to 1 subject', 'success')
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
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

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
        held: ['read'],
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
        held: ['read'],
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
    fireEvent.click(screen.getByRole('button', { name: 'diagram.PNG' }))

    const dialog = await screen.findByRole('dialog', { name: 'diagram.PNG' })
    await waitFor(() => expect(within(dialog).getByAltText('Preview of diagram.PNG')).toBeTruthy())
    expect(download).toHaveBeenCalledWith('gfs://main/image-1')
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }))
    expect(anchorClick).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'diagram.PNG' })).toBeNull())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-image-preview')
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

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Markdown preview' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Open GFS link' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open GFS link' })
    fireEvent.change(within(dialog).getByLabelText('gfs URI'), {
      target: { value: 'gfs://main/resource-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(openUri).toHaveBeenCalledWith('gfs://main/resource-1'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Open GFS link' })).toBeNull())
  })

  it('opens an SVG GFS link in preview and keeps its menu beside the file title', async () => {
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
      const [current, setCurrent] = useState<GfsCrumb | null>(null)
      selectResolvedFile = () => setCurrent(resolvedFile)
      return { ...baseController(), current, openUri }
    }
    hookMock.useGfsBrowserController.mockImplementation(useResolvedFileController)

    renderFilesPage()
    fireEvent.click(screen.getByRole('button', { name: 'Open GFS link' }))
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
    const title = screen.getByRole('heading', { name: 'architecture.svg' })
    const titleRow = title.closest('.da-gfs-current-file__title-row')
    expect(titleRow).toBeTruthy()
    expect(
      within(titleRow as HTMLElement).getByRole('button', { name: 'Options for architecture.svg' })
    ).toBeTruthy()
    expect(
      within(screen.getByRole('navigation', { name: 'File location' })).queryByRole('button', {
        name: 'Options for architecture.svg',
      })
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Options for architecture.svg' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview' }))
    expect(await screen.findByRole('dialog', { name: 'architecture.svg' })).toBeTruthy()
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
    await chooseManageAction('Product', 'New folder')
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'unfinished' } })
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Create folder' })).getByRole('button', {
        name: 'Cancel',
      })
    )
    await chooseManageAction('Product', 'New folder')

    expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('')
  })
})
