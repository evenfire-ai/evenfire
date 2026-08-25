import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES } from '@constants/gfsFileUpload'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
import {
  apiGet,
  apiSend,
  getAdminTeams,
  getAdminUsers,
  getGfsGrants,
  getGfsShares,
  getHosts,
  getRecipes,
  gfsDownload,
  gfsFetchFileBlob,
  putGfsGrant,
} from '@lib/api'
import {
  GfsUploadCapabilityError,
  createGfsUploadJob,
  normalizeUploadProductMaxBytes,
  uploadGfsFile,
} from '@lib/gfsFileUpload'
import { normalizeGfsResourceName } from '@lib/gfsResourceName'
import { GfsBrowser } from '../GfsBrowser'
import { ToastProvider } from '../Toast'

vi.mock('@lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  GFS_UPLOAD_TIMEOUT_MS: 300000,
  getAdminTeams: vi.fn(),
  getAdminUsers: vi.fn(),
  getGfsGrants: vi.fn(),
  getGfsShares: vi.fn(),
  getHosts: vi.fn(),
  getRecipes: vi.fn(),
  gfsDownload: vi.fn(),
  gfsFetchFileBlob: vi.fn(),
  isSilentApiError: () => false,
  putGfsGrant: vi.fn(),
}))

vi.mock('@lib/gfsFileUpload', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/gfsFileUpload')>()),
  uploadGfsFile: vi.fn().mockResolvedValue({ state: 'completed' }),
  createGfsUploadJob: vi.fn((input: { file: File; onState?: (snapshot: unknown) => void }) => ({
    start: vi.fn(async () => {
      input.onState?.({
        state: 'completed',
        session: { uploadId: 'test-upload', state: 'completed' },
        uploadedBytes: input.file.size,
        totalBytes: input.file.size,
      })
      return { state: 'completed', uploadId: 'test-upload' }
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  })),
}))

const mockApiGet = apiGet as unknown as ReturnType<typeof vi.fn>
const mockApiSend = apiSend as unknown as ReturnType<typeof vi.fn>
const mockGetAdminUsers = vi.mocked(getAdminUsers)
const mockGetAdminTeams = vi.mocked(getAdminTeams)
const mockGetGfsGrants = vi.mocked(getGfsGrants)
const mockGetGfsShares = vi.mocked(getGfsShares)
const mockGetHosts = vi.mocked(getHosts)
const mockGetRecipes = vi.mocked(getRecipes)
const mockPutGfsGrant = putGfsGrant as unknown as ReturnType<typeof vi.fn>
const mockGfsDownload = gfsDownload as unknown as ReturnType<typeof vi.fn>
const mockGfsFetchFileBlob = gfsFetchFileBlob as unknown as ReturnType<typeof vi.fn>
const mockUploadGfsFile = uploadGfsFile as unknown as ReturnType<typeof vi.fn>
const mockCreateGfsUploadJob = createGfsUploadJob as unknown as ReturnType<typeof vi.fn>
const mockCreateObjectUrl = vi.fn((_blob: Blob) => 'blob:gfs-image-preview')
const mockRevokeObjectUrl = vi.fn()

function renderBrowser() {
  return render(
    <ToastProvider>
      <GfsBrowser />
    </ToastProvider>
  )
}

async function openSubjectPicker() {
  const subjectInput = await screen.findByRole('combobox', {
    name: 'Add people, teams, agents, or workflows',
  })
  fireEvent.focus(subjectInput)
}

function selectPermission(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: label }))
}

async function confirmGrantAccess() {
  const dialog = await screen.findByRole('alertdialog', { name: 'Grant access?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
}

async function openResourceMenu(resourceName: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${resourceName}` }))
}

async function openManage(resourceName: string) {
  await openResourceMenu(resourceName)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Manage access' }))
}

function child(name: string, kind: string, n: number) {
  return {
    resourceId: `id-${n}`,
    rid: `r${n}`,
    gfsUri: `gfs://main/r${n}`,
    name,
    kind,
    path: `/${name}`,
    bytes: 0,
    version: 0,
  }
}

describe('GfsBrowser', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiSend.mockReset()
    mockGetAdminUsers.mockReset()
    mockGetAdminTeams.mockReset()
    mockGetGfsGrants.mockReset()
    mockGetGfsShares.mockReset()
    mockGetHosts.mockReset()
    mockGetRecipes.mockReset()
    mockPutGfsGrant.mockReset()
    mockGfsDownload.mockReset()
    mockGfsFetchFileBlob.mockReset()
    mockCreateGfsUploadJob.mockClear()
    mockUploadGfsFile.mockReset()
    window.localStorage.clear()
    mockUploadGfsFile.mockImplementation(async ({ file }: { file: File }) => {
      if (file.size > GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES) {
        throw new Error('GFS uploads cannot exceed the 1 GiB Upload v2 protocol maximum.')
      }
      return { state: 'completed' }
    })
    mockCreateObjectUrl.mockReset()
    mockCreateObjectUrl.mockReturnValue('blob:gfs-image-preview')
    mockRevokeObjectUrl.mockReset()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mockCreateObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mockRevokeObjectUrl,
    })
    mockGetAdminUsers.mockResolvedValue({
      items: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          email: 'ada@example.test',
          name: 'Ada Lovelace',
          displayName: 'Ada Lovelace',
          picture: null,
          activeTeamCount: 1,
        },
      ],
    })
    mockGetAdminTeams.mockResolvedValue({
      items: [{ id: '22222222-2222-2222-2222-222222222222', name: 'Research', memberCount: 2 }],
    })
    mockGetHosts.mockResolvedValue({ items: [{ metadata: { name: 'chatllm' } }] })
    mockGetRecipes.mockResolvedValue({
      items: [{ metadata: { namespace: 'sandbox-recipes', name: 'sandbox-ui-hello' } }],
    })
    mockGetGfsGrants.mockResolvedValue({ items: [] })
    mockGetGfsShares.mockResolvedValue({ items: [] })
  })

  it('loads the root tree and renders directories + files', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('org', 'directory', 1), child('readme.md', 'file', 2)],
      nextCursor: null,
    })
    renderBrowser()
    await screen.findAllByText(/org/)
    await screen.findAllByText(/readme\.md/)
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy()
    expect(screen.queryByText('Drive map')).toBeNull()
    await openResourceMenu('readme.md')
    expect(screen.getByRole('menuitem', { name: 'Copy GFS link' }).getAttribute('title')).toBe(
      'gfs://main/r2'
    )
    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/gfs/tree', { drive: 'main' })
  })

  it('shows the subtle loader during initial load and folder navigation', async () => {
    let resolveRoot: ((value: unknown) => void) | undefined
    let resolveFolder: ((value: unknown) => void) | undefined
    mockApiGet
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveRoot = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveFolder = resolve
        })
      )
    renderBrowser()

    const initialLoader = screen.getByRole('status', { name: 'Loading files' })
    expect(initialLoader).toHaveClass('cu-gfs-loading')
    expect(initialLoader.querySelectorAll('.cu-gfs-loading__dot')).toHaveLength(3)
    expect(screen.queryByText('Loading resources...')).toBeNull()

    await act(async () => {
      resolveRoot?.({
        items: [child('org', 'directory', 1)],
        nextCursor: null,
      })
    })
    fireEvent.click((await screen.findAllByRole('button', { name: 'org' }))[0])

    expect(screen.getByRole('status', { name: 'Loading files' })).toHaveClass('cu-gfs-loading')
    expect(screen.queryByRole('list', { name: 'Current folder resources' })).toBeNull()

    await act(async () => {
      resolveFolder?.({ items: [], nextCursor: null })
    })
    expect(await screen.findByText('No resources are visible in this folder.')).toBeTruthy()
  })

  it('shows operator CRUD controls and creates a folder in the current folder', async () => {
    mockApiGet.mockResolvedValueOnce({
      rootResourceId: '11111111-1111-1111-1111-111111111111',
      items: [],
      nextCursor: null,
    })
    mockApiGet.mockResolvedValueOnce({ items: [], nextCursor: null })
    mockApiGet.mockResolvedValueOnce({ items: [], nextCursor: null })
    mockApiSend.mockResolvedValueOnce({ ok: true })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')
    const newFolder = await screen.findByRole('button', { name: /new folder/i })
    const newFile = screen.getByRole('button', { name: /upload file/i })
    expect(newFolder).not.toBeDisabled()
    expect(newFile).not.toBeDisabled()
    expect(screen.queryByText(/files around 110 MB/i)).toBeNull()

    fireEvent.click(newFile)
    const uploadDialog = await screen.findByRole('dialog', { name: 'Upload file' })
    expect(
      within(uploadDialog).getByText(/1 GiB Upload v2 protocol ceiling is the local safety bound/i)
    ).toBeTruthy()
    expect(
      within(uploadDialog).getByText(/writer resolves and enforces the actual product file limit/i)
    ).toBeTruthy()
    expect(within(uploadDialog).getByText(/drag and drop, or click to browse/i)).toBeTruthy()
    fireEvent.click(within(uploadDialog).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(newFolder)
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'new-folder' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
    await waitFor(() =>
      expect(mockApiSend).toHaveBeenCalledWith(
        'POST',
        '/api/v1/gfs/proxy/v1/resources/11111111111111111111111111111111/children',
        { name: 'new-folder', kind: 'directory' }
      )
    )
  })

  it('shortens oversized folder and upload names before operator writes', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    const rootRid = '11111111111111111111111111111111'
    const rawFolderName = `operator-folder-${'very-long-'.repeat(32)}child`
    const folderName = await normalizeGfsResourceName(rawFolderName)
    const rawFileName = `operator-upload-${'very-long-'.repeat(32)}report.txt`
    const fileName = await normalizeGfsResourceName(rawFileName)
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    mockApiSend.mockResolvedValue({ ok: true })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    fireEvent.click(await screen.findByRole('button', { name: /new folder/i }))
    const folderDialog = await screen.findByRole('dialog')
    fireEvent.change(within(folderDialog).getByLabelText('Folder name'), {
      target: { value: rawFolderName },
    })
    fireEvent.click(within(folderDialog).getByRole('button', { name: 'Create folder' }))
    await waitFor(() =>
      expect(mockApiSend).toHaveBeenCalledWith(
        'POST',
        `/api/v1/gfs/proxy/v1/resources/${rootRid}/children`,
        { name: folderName, kind: 'directory' }
      )
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /upload file/i }))
    const uploadDialog = await screen.findByRole('dialog', { name: 'Upload file' })
    fireEvent.change(within(uploadDialog).getByLabelText('Choose file to upload'), {
      target: {
        files: [new File(['operator upload'], rawFileName, { type: 'text/plain' })],
      },
    })
    fireEvent.click(within(uploadDialog).getByRole('button', { name: 'Upload' }))

    await waitFor(() =>
      expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: fileName,
          target: { operation: 'create', parentRid: rootRid },
          file: expect.any(File),
        })
      )
    )
  })

  it('reuses a matching persisted session from the button upload path', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    const rootRid = '11111111111111111111111111111111'
    const uploadId = '88888888-8888-4888-8888-888888888888'
    const lastModified = 1_725_000_000_000
    const fileName = 'button-resume.md'
    window.localStorage.setItem(
      'evenfire:gfs-upload-v2:pending',
      JSON.stringify({
        uploadId,
        fileName,
        fileSize: 11,
        lastModified,
        target: { operation: 'create', parentRid: rootRid },
        name: fileName,
      })
    )
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    fireEvent.click(screen.getByRole('button', { name: /upload file/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Upload file' })
    fireEvent.change(within(dialog).getByLabelText('Choose file to upload'), {
      target: { files: [new File(['button data'], fileName, { lastModified })] },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }))

    await waitFor(() =>
      expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.any(File),
          name: fileName,
          resumeUploadId: uploadId,
          target: { operation: 'create', parentRid: rootRid },
        })
      )
    )
  })

  it('uploads dropped images and Markdown files into the current folder', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    const rootRid = '11111111111111111111111111111111'
    mockApiGet.mockResolvedValue({
      rootResourceId: rootId,
      items: [],
      nextCursor: null,
    })
    mockApiSend.mockResolvedValue({ ok: true })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    const image = new File(['operator image'], 'diagram.png', { type: 'image/png' })
    const markdown = new File(['# Operator notes'], 'notes.md', { type: 'text/markdown' })
    const dataTransfer = { dropEffect: 'none', files: [image, markdown], types: ['Files'] }

    fireEvent.dragEnter(browser.querySelector('.cu-gfs-card')!, { dataTransfer })
    const dropStatus = screen.getByRole('status')
    expect(dropStatus).toHaveTextContent('Drop files to upload to main')
    expect(dropStatus).toHaveClass('cu-gfs-drop-overlay')

    fireEvent.drop(browser.querySelector('.cu-gfs-card')!, { dataTransfer })

    await waitFor(() =>
      expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'diagram.png',
          target: { operation: 'create', parentRid: rootRid },
        })
      )
    )
    expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'notes.md',
        target: { operation: 'create', parentRid: rootRid },
      })
    )
  })

  it('reuses the matching persisted session when a file is resumed through drag-and-drop', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    const rootRid = '11111111111111111111111111111111'
    const uploadId = '55555555-5555-4555-8555-555555555555'
    const lastModified = 1_725_000_000_000
    window.localStorage.setItem(
      'evenfire:gfs-upload-v2:pending',
      JSON.stringify({
        uploadId,
        fileName: 'resume.md',
        fileSize: 11,
        lastModified,
        target: { operation: 'create', parentRid: rootRid },
        name: 'resume.md',
      })
    )
    mockApiGet.mockResolvedValue({
      rootResourceId: rootId,
      items: [],
      nextCursor: null,
    })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    const file = new File(['resume data'], 'resume.md', {
      type: 'text/markdown',
      lastModified,
    })
    const dataTransfer = { dropEffect: 'none', files: [file], types: ['Files'] }
    fireEvent.drop(browser.querySelector('.cu-gfs-card')!, { dataTransfer })

    await waitFor(() =>
      expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
        expect.objectContaining({
          file,
          resumeUploadId: uploadId,
          target: { operation: 'create', parentRid: rootRid },
        })
      )
    )
  })

  it('keeps a persisted drag-and-drop session when resumable capabilities are unavailable', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    const rootRid = '11111111111111111111111111111111'
    const uploadId = '77777777-7777-4777-8777-777777777777'
    const lastModified = 1_725_000_000_000
    window.localStorage.setItem(
      'evenfire:gfs-upload-v2:pending',
      JSON.stringify({
        uploadId,
        fileName: 'resume.md',
        fileSize: 11,
        lastModified,
        target: { operation: 'create', parentRid: rootRid },
        name: 'resume.md',
      })
    )
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    mockCreateGfsUploadJob.mockImplementationOnce(() => ({
      start: vi
        .fn()
        .mockRejectedValue(
          new GfsUploadCapabilityError('writer unavailable', { allowLegacyFallback: true })
        ),
      snapshot: vi.fn(() => ({ state: 'failed' })),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    }))
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    const file = new File(['resume data'], 'resume.md', {
      type: 'text/markdown',
      lastModified,
    })
    fireEvent.drop(browser.querySelector('.cu-gfs-card')!, {
      dataTransfer: { dropEffect: 'none', files: [file], types: ['Files'] },
    })

    await waitFor(() =>
      expect(screen.getByText(/persisted resumable session cannot be resumed/i)).toBeTruthy()
    )
    expect(mockApiSend).not.toHaveBeenCalled()
    expect(
      JSON.parse(window.localStorage.getItem('evenfire:gfs-upload-v2:pending')!)
    ).toMatchObject({
      uploadId,
    })
  })

  it('fails loudly without legacy fallback for malformed resumable capabilities', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    let malformed: unknown
    try {
      normalizeUploadProductMaxBytes(0)
    } catch (error) {
      malformed = error
    }
    expect(malformed).toBeInstanceOf(GfsUploadCapabilityError)
    mockCreateGfsUploadJob.mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(malformed),
      snapshot: vi.fn(() => ({ state: 'failed' })),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    }))
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    fireEvent.drop(browser.querySelector('.cu-gfs-card')!, {
      dataTransfer: {
        dropEffect: 'none',
        files: [new File(['payload'], 'payload.bin')],
        types: ['Files'],
      },
    })

    await waitFor(() => expect(screen.getByText((malformed as Error).message)).toBeTruthy())
    expect(mockApiSend).not.toHaveBeenCalled()
    expect(screen.queryByText(/using the legacy 16 MiB path/i)).toBeNull()
  })

  it('shows byte progress and exposes pause/resume/cancel through the visible upload modal', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    const rootRid = '11111111111111111111111111111111'
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    const completed = {
      uploadId: '55555555-5555-4555-8555-555555555555',
      state: 'completed',
      expectedBytes: 4,
      committedBytes: 4,
    }
    const paused = { ...completed, state: 'paused', committedBytes: 2 }
    let resolveStart: ((value: typeof completed) => void) | undefined
    let uploadInput:
      | {
          onState?: (snapshot: unknown) => void
          onProgress?: (progress: { uploadedBytes: number }) => void
        }
      | undefined
    const job = {
      start: vi.fn(() => {
        uploadInput?.onState?.({
          state: 'uploading',
          session: { ...completed, state: 'uploading' },
          uploadedBytes: 2,
          totalBytes: 4,
        })
        // Simulate an out-of-order in-flight part reporting a later absolute
        // offset before the accumulator commits the lower-numbered part.
        uploadInput?.onProgress?.({ uploadedBytes: 3 })
        // A failed retry clears that part's in-flight contribution. The UI
        // intentionally permits the truthful downward correction; the
        // monotonic guard applies only to stale uploading snapshots.
        uploadInput?.onProgress?.({ uploadedBytes: 1 })
        uploadInput?.onState?.({
          state: 'uploading',
          session: { ...completed, state: 'uploading' },
          uploadedBytes: 2,
          totalBytes: 4,
        })
        return new Promise<typeof completed>(resolve => {
          resolveStart = resolve
        })
      }),
      pause: vi.fn(async () => {
        uploadInput?.onState?.({
          state: 'paused',
          session: paused,
          uploadedBytes: 2,
          totalBytes: 4,
        })
        return paused
      }),
      resume: vi.fn(async () => {
        uploadInput?.onState?.({
          state: 'uploading',
          session: { ...completed, state: 'uploading' },
          uploadedBytes: 2,
          totalBytes: 4,
        })
        uploadInput?.onState?.({
          state: 'completed',
          session: completed,
          uploadedBytes: 4,
          totalBytes: 4,
        })
        resolveStart?.(completed)
        return completed
      }),
      cancel: vi.fn(async () => undefined),
    }
    mockCreateGfsUploadJob.mockImplementationOnce(
      (input: {
        onState?: (snapshot: unknown) => void
        onProgress?: (progress: { uploadedBytes: number }) => void
      }) => {
        uploadInput = input
        return job
      }
    )
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')
    fireEvent.click(screen.getByRole('button', { name: /upload file/i }))
    const uploadDialog = await screen.findByRole('dialog', { name: 'Upload file' })
    fireEvent.change(within(uploadDialog).getByLabelText('Choose file to upload'), {
      target: { files: [new File(['data'], 'payload.bin')] },
    })
    fireEvent.click(within(uploadDialog).getByRole('button', { name: 'Upload' }))
    const progress = await within(uploadDialog).findByRole('progressbar', {
      name: /Upload progress/,
    })
    expect(progress).toHaveAttribute('value', '2')
    expect(progress).toHaveAttribute('aria-valuemin', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '4')
    expect(progress).toHaveAttribute('aria-valuenow', '2')
    fireEvent.click(within(uploadDialog).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(job.pause).toHaveBeenCalledTimes(1))
    expect(await within(uploadDialog).findByRole('button', { name: 'Resume' })).toBeTruthy()
    fireEvent.click(within(uploadDialog).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(job.resume).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload file' })).toBeNull())
    expect(job.cancel).not.toHaveBeenCalled()
    expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
      expect.objectContaining({ target: { operation: 'create', parentRid: rootRid } })
    )
  })

  it('rejects oversized dropped files before reading or uploading them', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    mockApiGet.mockResolvedValue({
      rootResourceId: rootId,
      items: [],
      nextCursor: null,
    })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')
    const oversized = new File(['small fixture'], 'oversized.md', { type: 'text/markdown' })
    Object.defineProperty(oversized, 'size', { value: GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES + 1 })
    const arrayBuffer = vi.spyOn(oversized, 'arrayBuffer')

    const browser = screen.getByRole('region', { name: 'Global File System browser' })
    fireEvent.drop(browser.querySelector('.cu-gfs-card')!, {
      dataTransfer: { dropEffect: 'none', files: [oversized], types: ['Files'] },
    })

    expect(
      await screen.findByText('GFS uploads cannot exceed the 1 GiB Upload v2 protocol maximum.')
    ).toBeTruthy()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(mockApiSend).not.toHaveBeenCalled()
  })

  it('shortens oversized rename names before operator patches a resource', async () => {
    const rawRename = `operator-rename-${'very-long-'.repeat(32)}report.txt`
    const renamed = await normalizeGfsResourceName(rawRename)
    mockApiGet.mockResolvedValueOnce({
      items: [child('report.txt', 'file', 2)],
      nextCursor: null,
    })
    mockApiGet.mockResolvedValueOnce({ items: [child(renamed, 'file', 2)], nextCursor: null })
    mockApiSend.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    const currentResources = await screen.findByRole('list', { name: 'Current folder resources' })
    const reportRow = within(currentResources).getByText('report.txt').closest('li')
    expect(reportRow).toBeTruthy()
    await openResourceMenu('report.txt')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const renameForm = await screen.findByRole('form', { name: 'Rename resource' })
    fireEvent.change(within(renameForm).getByLabelText('New name'), {
      target: { value: rawRename },
    })
    fireEvent.click(within(renameForm).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mockApiSend).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/gfs/resources/id-2',
        { drive: 'main', newName: renamed, ifMatch: 0 },
        { drive: 'main' }
      )
    )
  })

  it('downloads a file through the operator content proxy using rid + name', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('report.md', 'file', 2)],
      nextCursor: null,
    })
    mockGfsDownload.mockResolvedValueOnce(undefined)
    renderBrowser()

    const currentResources = await screen.findByRole('list', { name: 'Current folder resources' })
    const reportRow = within(currentResources).getByText('report.md').closest('li')
    expect(reportRow).toBeTruthy()
    fireEvent.click(within(reportRow!).getByRole('button', { name: 'Download report.md' }))

    await waitFor(() => expect(mockGfsDownload).toHaveBeenCalledWith('r2', 'report.md'))
  })

  it('surfaces download failures through the toast stack', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('report.md', 'file', 2)],
      nextCursor: null,
    })
    mockGfsDownload.mockRejectedValueOnce(new Error('download unavailable'))
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: 'Download report.md' }))

    expect(await screen.findByRole('status')).toHaveTextContent('download unavailable')
  })

  it('previews supported image files from the file name and resource menu', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('avatar.PNG', 'file', 2), child('notes.txt', 'file', 3)],
      nextCursor: null,
    })
    mockGfsFetchFileBlob.mockResolvedValue(new Blob(['image bytes']))
    renderBrowser()

    const previewTrigger = await screen.findByRole('button', { name: 'avatar.PNG' })
    expect(screen.getByText('notes.txt').closest('button')).toBeNull()
    fireEvent.click(previewTrigger)

    const dialog = await screen.findByRole('dialog', { name: 'avatar.PNG' })
    expect(
      await within(dialog).findByRole('img', { name: 'Preview of avatar.PNG' })
    ).toHaveAttribute('src', 'blob:gfs-image-preview')
    expect(mockGfsFetchFileBlob).toHaveBeenCalledWith('r2')
    expect((mockCreateObjectUrl.mock.calls[0]?.[0] as Blob).type).toBe('image/png')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'avatar.PNG' })).toBeNull())
    expect(mockRevokeObjectUrl).toHaveBeenCalledWith('blob:gfs-image-preview')

    await openResourceMenu('avatar.PNG')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview' }))
    expect(await screen.findByRole('dialog', { name: 'avatar.PNG' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'avatar.PNG' })).toBeNull())

    await openResourceMenu('notes.txt')
    expect(screen.queryByRole('menuitem', { name: 'Preview' })).toBeNull()
  })

  it('surfaces image preview loading failures inside the modal', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('diagram.svg', 'file', 4)],
      nextCursor: null,
    })
    mockGfsFetchFileBlob.mockRejectedValueOnce(new Error('preview unavailable'))
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: 'diagram.svg' }))
    const dialog = await screen.findByRole('dialog', { name: 'diagram.svg' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('preview unavailable')
  })

  it('rejects oversized image previews before downloading them', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [{ ...child('oversized.png', 'file', 4), bytes: GFS_IMAGE_PREVIEW_MAX_BYTES + 1 }],
      nextCursor: null,
    })
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: 'oversized.png' }))
    const dialog = await screen.findByRole('dialog', { name: 'oversized.png' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Image previews are limited to 10 MB.'
    )
    expect(mockGfsFetchFileBlob).not.toHaveBeenCalled()
  })

  it('previews Markdown files with safe vanilla rendering', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('README.md', 'file', 5)],
      nextCursor: null,
    })
    mockGfsFetchFileBlob.mockResolvedValueOnce(
      new Blob([
        '# Project guide\n\nUse **safe rendering**.\n\n- First\n- Second\n\n[Unsafe](javascript:alert)\n\n<script>alert("no")</script>',
      ])
    )
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))

    const dialog = await screen.findByRole('dialog', { name: 'README.md' })
    expect(
      await within(dialog).findByRole('heading', { name: 'Project guide', level: 1 })
    ).toBeTruthy()
    expect(within(dialog).getByText('safe rendering').tagName).toBe('STRONG')
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
    expect(within(dialog).getByText('Unsafe').closest('a')).toBeNull()
    expect(dialog.querySelector('script')).toBeNull()
    expect(mockGfsFetchFileBlob).toHaveBeenCalledWith('r5')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Markdown preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'README.md' })).toBeNull())

    await openResourceMenu('README.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview' }))
    expect(await screen.findByRole('dialog', { name: 'README.md' })).toBeTruthy()
  })

  it('rejects oversized Markdown previews before downloading them', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [{ ...child('oversized.md', 'file', 5), bytes: GFS_MARKDOWN_PREVIEW_MAX_BYTES + 1 }],
      nextCursor: null,
    })
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: 'oversized.md' }))
    const dialog = await screen.findByRole('dialog', { name: 'oversized.md' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Markdown previews are limited to 2 MB.'
    )
    expect(mockGfsFetchFileBlob).not.toHaveBeenCalled()
  })

  it('opens folders from their name and replaces files from the resource menu', async () => {
    mockApiGet
      .mockResolvedValueOnce({
        items: [child('org', 'directory', 1), child('report.md', 'file', 2)],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({
        items: [child('org', 'directory', 1), child('report.md', 'file', 2)],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
    mockApiSend.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    await openResourceMenu('org')
    expect(screen.queryByRole('menuitem', { name: 'Open folder' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'org' }))
    await waitFor(() =>
      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/gfs/resources/id-1/children', {
        drive: 'main',
      })
    )

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    fireEvent.click(within(breadcrumb).getAllByRole('button')[0])
    await screen.findByText('report.md')
    await openResourceMenu('report.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace file' }))
    fireEvent.change(screen.getByLabelText('Replace report.md'), {
      target: { files: [new File(['replacement'], 'report.md', { type: 'text/markdown' })] },
    })

    await waitFor(() =>
      expect(mockCreateGfsUploadJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'report.md',
          file: expect.any(File),
          target: { operation: 'replace', resourceRid: 'r2', ifMatch: 0 },
        })
      )
    )
  })

  it('does not fall back to legacy when replacing a persisted resumable session', async () => {
    const lastModified = 1_725_000_000_000
    const uploadId = '66666666-6666-4666-8666-666666666666'
    window.localStorage.setItem(
      'evenfire:gfs-upload-v2:pending',
      JSON.stringify({
        uploadId,
        fileName: 'report.md',
        fileSize: 11,
        lastModified,
        target: { operation: 'replace', resourceRid: 'r2', ifMatch: 0 },
        name: 'report.md',
      })
    )
    mockApiGet.mockResolvedValueOnce({
      items: [child('report.md', 'file', 2)],
      nextCursor: null,
    })
    const capabilityError = new GfsUploadCapabilityError('writer unavailable', {
      allowLegacyFallback: true,
    })
    mockCreateGfsUploadJob.mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(capabilityError),
      snapshot: vi.fn(() => ({ state: 'failed' })),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    }))
    renderBrowser()

    await openResourceMenu('report.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace file' }))
    fireEvent.change(screen.getByLabelText('Replace report.md'), {
      target: {
        files: [new File(['resume data'], 'report.md', { lastModified })],
      },
    })

    await waitFor(() =>
      expect(screen.getByText(/persisted resumable session cannot be resumed/i)).toBeTruthy()
    )
    expect(mockApiSend).not.toHaveBeenCalled()
    expect(
      JSON.parse(window.localStorage.getItem('evenfire:gfs-upload-v2:pending')!)
    ).toMatchObject({
      uploadId,
    })
  })

  it('supports roving keyboard focus and Escape in the resource menu', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('report.md', 'file', 2)],
      nextCursor: null,
    })
    renderBrowser()

    await openResourceMenu('report.md')
    const manageItem = screen.getByRole('menuitem', { name: 'Manage access' })
    await waitFor(() => expect(document.activeElement).toBe(manageItem))
    fireEvent.keyDown(manageItem, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Preview' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for report.md' })
    )
  })

  it('does not render a download button for directories', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('org', 'directory', 1)],
      nextCursor: null,
    })
    renderBrowser()
    await screen.findAllByText(/org/)
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull()
  })

  it('navigates into a directory and lists its children', async () => {
    mockApiGet
      .mockResolvedValueOnce({ items: [child('org', 'directory', 1)], nextCursor: null })
      .mockResolvedValueOnce({ items: [child('eng', 'directory', 3)], nextCursor: null })
      .mockResolvedValueOnce({ items: [child('org', 'directory', 1)], nextCursor: null })
    renderBrowser()
    const orgButton = (await screen.findAllByRole('button', { name: 'org' }))[0]
    fireEvent.click(orgButton)
    await screen.findAllByText(/eng/)
    expect(mockApiGet).toHaveBeenLastCalledWith('/api/v1/gfs/resources/id-1/children', {
      drive: 'main',
    })
    // Navigate back to the drive root via the breadcrumb root crumb (Back/Forward were removed).
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    fireEvent.click(within(breadcrumb).getAllByRole('button')[0])
    await screen.findAllByRole('button', { name: 'org' })
  })

  it('keeps the new-folder modal open after an error and allows a retry', async () => {
    const rootId = '11111111-1111-1111-1111-111111111111'
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    mockApiSend
      .mockRejectedValueOnce(new Error('folder already exists'))
      .mockResolvedValueOnce({ ok: true })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'research' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('folder already exists')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))

    await waitFor(() => expect(mockApiSend).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New folder' })).toBeNull())
  })

  it('deletes a resource from the menu-backed manage dialog', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('obsolete.md', 'file', 4)],
      nextCursor: null,
    })
    mockApiGet.mockResolvedValueOnce({ items: [], nextCursor: null })
    mockApiSend.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    await openResourceMenu('obsolete.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Delete resource' })
    expect(within(confirmation).getByText('Delete obsolete.md?')).toBeTruthy()
    expect(within(confirmation).getByText('This action cannot be undone.')).toBeTruthy()
    expect(screen.queryByText('Access')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Replace file' })).toBeNull()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Delete resource' })).toBeNull()
    )
    expect(screen.queryByRole('dialog', { name: 'Manage file obsolete.md' })).toBeNull()

    await openResourceMenu('obsolete.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog', { name: 'Delete resource' })).getByRole(
        'button',
        { name: 'Delete' }
      )
    )

    await waitFor(() =>
      expect(mockApiSend).toHaveBeenCalledWith('DELETE', '/api/v1/gfs/proxy/v1/resources/r4', {
        ifMatch: 0,
      })
    )
  })

  it('surfaces a load error (fail-loud, not a silent empty tree)', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('boom'))
    renderBrowser()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
  })

  it('grants access to a selected bulk subject with the correct body', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [child('report.md', 'file', 2)], nextCursor: null })
    mockPutGfsGrant.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    await openManage('report.md')
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    await waitFor(() => expect(mockGetAdminTeams).toHaveBeenCalled())
    const manageDialog = screen.getByRole('dialog', { name: 'Manage file report.md' })
    const manageMenuTrigger = within(manageDialog).getByRole('button', {
      name: 'Actions for report.md',
    })
    expect(within(manageDialog).queryByRole('button', { name: 'Replace file' })).toBeNull()
    expect(within(manageDialog).queryByText('Quick actions')).toBeNull()
    fireEvent.click(manageMenuTrigger)
    const manageMenu = within(manageDialog).getByRole('menu')
    expect(within(manageMenu).getByRole('menuitem', { name: 'Download' })).toBeTruthy()
    expect(within(manageMenu).getByRole('menuitem', { name: 'Replace file' })).toBeTruthy()
    expect(within(manageMenu).getByRole('menuitem', { name: 'Copy GFS link' })).toBeTruthy()
    expect(within(manageMenu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(within(manageMenu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
    expect(within(manageMenu).queryByRole('menuitem', { name: 'Manage access' })).toBeNull()
    fireEvent.click(manageMenuTrigger)
    await openSubjectPicker()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    selectPermission('Read')
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await confirmGrantAccess()

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: 'id-2',
        subjects: [{ type: 'user', id: '11111111-1111-1111-1111-111111111111' }],
        permissions: ['read'],
        inherit: false,
      })
    )
  })

  it('keeps user grants available when agent or workflow directories fail', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [child('report.md', 'file', 2)], nextCursor: null })
    mockGetHosts.mockRejectedValueOnce(new Error('host directory unavailable'))
    mockGetRecipes.mockRejectedValueOnce(new Error('recipe directory unavailable'))
    renderBrowser()

    await openManage('report.md')
    await screen.findByText('Some grant subjects could not be loaded: agents, workflows')
    await openSubjectPicker()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    selectPermission('Read')

    expect(screen.getByRole('button', { name: 'Grant access' })).not.toBeDisabled()
  })

  it('includes descendants for directory grants and exposes share creation', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('team-folder', 'directory', 2)],
      nextCursor: null,
    })
    mockPutGfsGrant.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    await openManage('team-folder')
    expect(screen.queryByText('Manage folder')).toBeNull()
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    expect(await screen.findByRole('checkbox', { name: /Include descendants/ })).toBeChecked()
    expect(screen.getByText('Apply this grant or share to the full folder tree.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDisabled()
    await openSubjectPicker()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    selectPermission('Read')
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await confirmGrantAccess()

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'id-2',
          inherit: true,
        })
      )
    )
  })

  it('lets an operator select team and operator subjects without typing UUIDs', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [child('report.md', 'file', 2)], nextCursor: null })
    mockPutGfsGrant.mockResolvedValue({ ok: true })
    renderBrowser()

    await openManage('report.md')
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    await waitFor(() => expect(mockGetAdminTeams).toHaveBeenCalled())
    expect(screen.queryByLabelText('Subject ID')).toBeNull()

    await openSubjectPicker()
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'Ada Lovelace' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Research' }))
    selectPermission('Read')
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await confirmGrantAccess()

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          subjects: [{ type: 'team', id: '22222222-2222-2222-2222-222222222222' }],
        })
      )
    )

    await openSubjectPicker()
    fireEvent.click(await screen.findByRole('option', { name: 'Operator' }))
    selectPermission('Read')
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await confirmGrantAccess()

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subject: { type: 'operator' },
        })
      )
    )
  })

  it('surfaces the machine error code on a no-escalation rejection', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [child('report.md', 'file', 2)], nextCursor: null })
    mockPutGfsGrant.mockRejectedValueOnce(
      Object.assign(new Error('403 escalation_rejected'), { code: 'escalation_rejected' })
    )
    renderBrowser()

    await openManage('report.md')
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    await waitFor(() => expect(mockGetAdminTeams).toHaveBeenCalled())
    await openSubjectPicker()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    selectPermission('Write')
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await confirmGrantAccess()

    expect((await screen.findByText('escalation_rejected')).getAttribute('role')).toBe('alert')
  })
})
