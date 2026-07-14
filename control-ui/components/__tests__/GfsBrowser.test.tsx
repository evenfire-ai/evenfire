import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  apiGet,
  apiSend,
  getAdminTeams,
  getAdminUsers,
  getHosts,
  getRecipes,
  postGfsShare,
  putGfsGrant,
} from '@lib/api'
import { normalizeGfsResourceName } from '@lib/gfsResourceName'
import { GfsBrowser } from '../GfsBrowser'
import { ToastProvider } from '../Toast'

vi.mock('@lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  getAdminTeams: vi.fn(),
  getAdminUsers: vi.fn(),
  getHosts: vi.fn(),
  getRecipes: vi.fn(),
  isSilentApiError: () => false,
  putGfsGrant: vi.fn(),
  postGfsShare: vi.fn(),
}))

const mockApiGet = apiGet as unknown as ReturnType<typeof vi.fn>
const mockApiSend = apiSend as unknown as ReturnType<typeof vi.fn>
const mockGetAdminUsers = vi.mocked(getAdminUsers)
const mockGetAdminTeams = vi.mocked(getAdminTeams)
const mockGetHosts = vi.mocked(getHosts)
const mockGetRecipes = vi.mocked(getRecipes)
const mockPutGfsGrant = putGfsGrant as unknown as ReturnType<typeof vi.fn>
const mockPostGfsShare = postGfsShare as unknown as ReturnType<typeof vi.fn>

function renderBrowser() {
  return render(
    <ToastProvider>
      <GfsBrowser />
    </ToastProvider>
  )
}

async function openUserDropdown() {
  const subjectButton = await screen.findByRole('button', { name: 'User' })
  await waitFor(() => expect(subjectButton).toHaveTextContent('Choose a user'))
  fireEvent.click(subjectButton)
}

async function openTeamDropdown() {
  const subjectButton = await screen.findByRole('button', { name: 'Team' })
  await waitFor(() => expect(subjectButton).toHaveTextContent('Choose a team'))
  fireEvent.click(subjectButton)
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
    mockGetHosts.mockReset()
    mockGetRecipes.mockReset()
    mockPutGfsGrant.mockReset()
    mockPostGfsShare.mockReset()
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
  })

  it('loads the root tree and renders directories + files', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('org', 'directory', 1), child('readme.md', 'file', 2)],
      nextCursor: null,
    })
    renderBrowser()
    await screen.findAllByText(/org/)
    await screen.findAllByText(/readme\.md/)
    expect(screen.getByLabelText('Global File System folder tree')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Copy GFS link for readme.md' }).getAttribute('title')
    ).toBe('gfs://main/r2')
    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/gfs/tree', { drive: 'main' })
  })

  it('shows operator CRUD controls and creates a folder in the current folder', async () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce('new-folder')
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
    expect(newFolder).not.toBeDisabled()
    expect(screen.getByText(/upload file/i)).toBeTruthy()
    expect(screen.getByText(/raw files around 110 MB/i)).toBeTruthy()

    fireEvent.click(newFolder)
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
    vi.spyOn(window, 'prompt').mockReturnValueOnce(rawFolderName)
    mockApiGet.mockResolvedValue({ rootResourceId: rootId, items: [], nextCursor: null })
    mockApiSend.mockResolvedValue({ ok: true })
    renderBrowser()
    await screen.findByText('No resources are visible in this folder.')

    fireEvent.click(await screen.findByRole('button', { name: /new folder/i }))
    await waitFor(() =>
      expect(mockApiSend).toHaveBeenCalledWith(
        'POST',
        `/api/v1/gfs/proxy/v1/resources/${rootRid}/children`,
        { name: folderName, kind: 'directory' }
      )
    )

    fireEvent.change(screen.getByLabelText('Upload file'), {
      target: {
        files: [new File(['operator upload'], rawFileName, { type: 'text/plain' })],
      },
    })

    await waitFor(() =>
      expect(mockApiSend).toHaveBeenLastCalledWith(
        'POST',
        `/api/v1/gfs/proxy/v1/resources/${rootRid}/children`,
        {
          name: fileName,
          kind: 'file',
          contentBase64: 'b3BlcmF0b3IgdXBsb2Fk',
        }
      )
    )
  })

  it('shortens oversized rename names before operator patches a resource', async () => {
    const rawRename = `operator-rename-${'very-long-'.repeat(32)}report.txt`
    const renamed = await normalizeGfsResourceName(rawRename)
    vi.spyOn(window, 'prompt').mockReturnValueOnce(rawRename)
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
    fireEvent.click(within(reportRow!).getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(mockApiSend).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/gfs/resources/id-2',
        { drive: 'main', newName: renamed, ifMatch: 0 },
        { drive: 'main' }
      )
    )
  })

  it('navigates into a directory and lists its children', async () => {
    mockApiGet
      .mockResolvedValueOnce({ items: [child('org', 'directory', 1)], nextCursor: null })
      .mockResolvedValueOnce({ items: [child('eng', 'directory', 3)], nextCursor: null })
      .mockResolvedValueOnce({ items: [child('org', 'directory', 1)], nextCursor: null })
      .mockResolvedValueOnce({ items: [child('eng', 'directory', 3)], nextCursor: null })
    renderBrowser()
    expect(await screen.findByRole('button', { name: 'Back' })).toBeDisabled()
    const orgButton = (await screen.findAllByRole('button', { name: 'org' }))[0]
    fireEvent.click(orgButton)
    await screen.findAllByText(/eng/)
    expect(mockApiGet).toHaveBeenLastCalledWith('/api/v1/gfs/resources/id-1/children', {
      drive: 'main',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findAllByRole('button', { name: 'org' })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await screen.findAllByRole('button', { name: 'eng' })
  })

  it('surfaces a load error (fail-loud, not a silent empty tree)', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('boom'))
    renderBrowser()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
  })

  it('operator grants access on a selected resource (confirmed) with the correct body', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [child('report.md', 'file', 2)], nextCursor: null })
    mockPutGfsGrant.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: /manage access/i }))
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    await waitFor(() => expect(mockGetAdminTeams).toHaveBeenCalled())
    expect(screen.getByLabelText('Subject type')).toHaveValue('user')
    await openUserDropdown()
    expect(
      within(screen.getByRole('listbox')).queryByRole('option', { name: 'Operator' })
    ).toBeNull()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))

    // Confirm in the dialog (its confirm button shares the "Grant" label).
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant' }))

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: 'id-2',
        subject: { type: 'user', id: '11111111-1111-1111-1111-111111111111' },
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

    fireEvent.click(await screen.findByRole('button', { name: /manage access/i }))
    await screen.findByText('Some grant subjects could not be loaded: agents, workflows')
    await openUserDropdown()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))

    expect(screen.getByRole('button', { name: 'Grant' })).not.toBeDisabled()
  })

  it('includes descendants for directory grants and shares when requested', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [child('team-folder', 'directory', 2)],
      nextCursor: null,
    })
    mockPutGfsGrant.mockResolvedValueOnce({ ok: true })
    mockPostGfsShare.mockResolvedValueOnce({ ok: true })
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: /manage access/i }))
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    expect(await screen.findByRole('checkbox', { name: /Include descendants/ })).toBeChecked()
    await openUserDropdown()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Grant' })
    )

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'id-2',
          inherit: true,
        })
      )
    )

    await openUserDropdown()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create share' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Create share' })
    )

    await waitFor(() =>
      expect(mockPostGfsShare).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'id-2',
          includeDescendants: true,
        })
      )
    )
  })

  it('lets an operator select team and operator subjects without typing UUIDs', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [child('report.md', 'file', 2)], nextCursor: null })
    mockPutGfsGrant.mockResolvedValue({ ok: true })
    renderBrowser()

    fireEvent.click(await screen.findByRole('button', { name: /manage access/i }))
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    await waitFor(() => expect(mockGetAdminTeams).toHaveBeenCalled())
    expect(screen.getByLabelText('Subject type')).toHaveValue('user')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'User' })).toHaveTextContent('Choose a user')
    )
    expect(screen.queryByLabelText('Subject ID')).toBeNull()

    fireEvent.change(screen.getByLabelText('Subject type'), { target: { value: 'team' } })
    await openTeamDropdown()
    expect(
      within(screen.getByRole('listbox')).queryByRole('option', { name: 'Ada Lovelace' })
    ).toBeNull()
    fireEvent.click(await screen.findByRole('option', { name: 'Research' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Grant' })
    )

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: { type: 'team', id: '22222222-2222-2222-2222-222222222222' },
        })
      )
    )

    await waitFor(() => expect(screen.getByLabelText('Subject type')).toHaveValue('user'))
    fireEvent.change(screen.getByLabelText('Subject type'), { target: { value: 'operator' } })
    expect(screen.queryByRole('button', { name: 'User' })).toBeNull()
    expect(
      screen.getByText(
        'The intrinsic cluster operator subject will receive the selected permissions.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Grant' })
    )

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

    fireEvent.click(await screen.findByRole('button', { name: /manage access/i }))
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalledWith(''))
    await waitFor(() => expect(mockGetAdminTeams).toHaveBeenCalled())
    await openUserDropdown()
    fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant' }))

    expect((await screen.findByText('escalation_rejected')).getAttribute('role')).toBe('alert')
  })
})
