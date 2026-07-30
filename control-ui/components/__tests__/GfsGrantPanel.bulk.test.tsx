import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  type GfsMutationResponse,
  type GfsSubjectInput,
  deleteGfsGrant,
  deleteGfsShare,
  getAdminTeams,
  getAdminUsers,
  getGfsGrants,
  getGfsShares,
  getHosts,
  getRecipes,
  postGfsShare,
  putGfsGrant,
} from '@lib/api'
import { GfsGrantPanel } from '../GfsGrantPanel'
import { ToastProvider } from '../Toast'

vi.mock('@lib/api', () => ({
  getAdminTeams: vi.fn(),
  getAdminUsers: vi.fn(),
  getHosts: vi.fn(),
  getRecipes: vi.fn(),
  getGfsGrants: vi.fn(),
  getGfsShares: vi.fn(),
  deleteGfsGrant: vi.fn(),
  deleteGfsShare: vi.fn(),
  postGfsShare: vi.fn(),
  putGfsGrant: vi.fn(),
}))

const mockGetAdminUsers = vi.mocked(getAdminUsers)
const mockGetAdminTeams = vi.mocked(getAdminTeams)
const mockGetHosts = vi.mocked(getHosts)
const mockGetRecipes = vi.mocked(getRecipes)
const mockGetGfsGrants = vi.mocked(getGfsGrants)
const mockGetGfsShares = vi.mocked(getGfsShares)
const mockDeleteGfsGrant = vi.mocked(deleteGfsGrant)
const mockDeleteGfsShare = vi.mocked(deleteGfsShare)
const mockPostGfsShare = vi.mocked(postGfsShare)
const mockPutGfsGrant = vi.mocked(putGfsGrant)

const resource = {
  resourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'report.md',
  gfsUri: 'gfs://main/report',
  kind: 'file',
}

const userSubject = { type: 'user', id: '11111111-1111-1111-1111-111111111111' } as const
const teamSubject = { type: 'team', id: '22222222-2222-2222-2222-222222222222' } as const
const statefulHostSubject = { type: 'host', id: '1st:mcp-host/chatllm' } as const
const statelessHostSubject = { type: 'host', id: '1st:mcp-host/chatllm-stateless' } as const
const workflowHostSubject = {
  type: 'host',
  id: '3rd:sandbox-recipes/sandbox-ui-hello',
} as const
const operatorSubject = { type: 'operator' } as const

function successfulMutation(...updated: GfsSubjectInput[]): GfsMutationResponse {
  return { ok: true, resourceId: resource.resourceId, updated, count: updated.length }
}

function renderPanel() {
  return render(
    <ToastProvider>
      <GfsGrantPanel resource={resource} />
    </ToastProvider>
  )
}

async function openSubjectPicker() {
  const input = await screen.findByRole('combobox', {
    name: 'Add people, teams, agents, or workflows',
  })
  fireEvent.mouseDown(input)
  fireEvent.focus(input)
  return screen.findByRole('listbox', { name: 'Available grant subjects' })
}

async function chooseSubjects(...names: string[]) {
  await openSubjectPicker()
  for (const name of names) fireEvent.click(screen.getByRole('option', { name }))
}

function openPermissionMenu() {
  let menu = screen.queryByRole('menu', { name: 'Permissions' })
  if (!menu) {
    const trigger = document.querySelector<HTMLButtonElement>(
      '.cu-gfs-permission-dropdown__trigger'
    )
    if (!trigger) throw new Error('permission trigger missing')
    fireEvent.click(trigger)
    menu = screen.getByRole('menu', { name: 'Permissions' })
  }
  return menu
}

function selectPermission(name: string) {
  fireEvent.click(within(openPermissionMenu()).getByRole('menuitemcheckbox', { name }))
}

function submit(action: 'Grant access' | 'Create share') {
  fireEvent.click(screen.getByRole('button', { name: action }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
}

describe('GfsGrantPanel bulk access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    mockGetHosts.mockResolvedValue({
      items: [
        { metadata: { namespace: 'mcp-host', name: 'chatllm' } },
        {
          metadata: { namespace: 'mcp-host', name: 'chatllm-stateless' },
          spec: { lifecycle: { stateless: true } },
        },
      ],
    })
    mockGetRecipes.mockResolvedValue({
      items: [{ metadata: { namespace: 'sandbox-recipes', name: 'sandbox-ui-hello' } }],
    })
    mockGetGfsGrants.mockResolvedValue({ items: [] })
    mockGetGfsShares.mockResolvedValue({ items: [] })
    mockDeleteGfsGrant.mockResolvedValue(undefined)
    mockDeleteGfsShare.mockResolvedValue(undefined)
  })

  it('loads direct access on mount and revokes the selected persisted row', async () => {
    mockGetGfsGrants
      .mockResolvedValueOnce({
        items: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            drive: 'main',
            resourceId: resource.resourceId,
            subject: userSubject,
            permissions: ['read', 'write'],
            inherit: false,
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'Existing access' })
    expect(within(existing).getByText('Ada Lovelace')).toBeTruthy()
    expect(within(existing).getByText('Grant · read, write · resource only')).toBeTruthy()

    fireEvent.click(
      within(existing).getByRole('button', { name: 'Remove grant access for Ada Lovelace' })
    )
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove access' }))

    await waitFor(() =>
      expect(mockDeleteGfsGrant).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333')
    )
    await waitFor(() =>
      expect(within(existing).getByText('No direct access configured.')).toBeTruthy()
    )
    expect(mockGetGfsGrants).toHaveBeenCalledTimes(2)
    expect(mockGetGfsShares).toHaveBeenCalledTimes(2)
  })

  it('self-heals a row that another admin already revoked without hiding other errors', async () => {
    mockGetGfsGrants
      .mockResolvedValueOnce({
        items: [
          {
            id: '55555555-5555-5555-5555-555555555555',
            drive: 'main',
            resourceId: resource.resourceId,
            subject: userSubject,
            permissions: ['read'],
            inherit: false,
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] })
    mockDeleteGfsGrant.mockRejectedValueOnce(
      Object.assign(new Error('404 grant_not_found'), {
        status: 404,
        code: 'grant_not_found',
      })
    )
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'Existing access' })
    fireEvent.click(
      within(existing).getByRole('button', { name: 'Remove grant access for Ada Lovelace' })
    )
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove access' }))

    expect(await screen.findByText('Access was already removed.')).toBeTruthy()
    await waitFor(() =>
      expect(within(existing).getByText('No direct access configured.')).toBeTruthy()
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mockGetGfsGrants).toHaveBeenCalledTimes(2)
  })

  it('surfaces a non-idempotent revoke failure and keeps the persisted row visible', async () => {
    mockGetGfsGrants.mockResolvedValue({
      items: [
        {
          id: '66666666-6666-6666-6666-666666666666',
          drive: 'main',
          resourceId: resource.resourceId,
          subject: userSubject,
          permissions: ['read'],
          inherit: false,
        },
      ],
    })
    mockDeleteGfsGrant.mockRejectedValueOnce(
      Object.assign(new Error('403 not_manager'), {
        status: 403,
        code: 'not_manager',
      })
    )
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'Existing access' })
    fireEvent.click(
      within(existing).getByRole('button', { name: 'Remove grant access for Ada Lovelace' })
    )
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove access' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('403 not_manager')
    expect(within(existing).getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.queryByText('Access was already removed.')).toBeNull()
    expect(mockGetGfsGrants).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest post-mutation hydration when the initial request resolves late', async () => {
    let resolveInitialGrants!: (value: Awaited<ReturnType<typeof getGfsGrants>>) => void
    const initialGrants = new Promise<Awaited<ReturnType<typeof getGfsGrants>>>(resolve => {
      resolveInitialGrants = resolve
    })
    mockGetGfsGrants.mockReturnValueOnce(initialGrants).mockResolvedValueOnce({
      items: [
        {
          id: '44444444-4444-4444-4444-444444444444',
          drive: 'main',
          resourceId: resource.resourceId,
          subject: userSubject,
          permissions: ['read'],
          inherit: false,
        },
      ],
    })
    mockPutGfsGrant.mockResolvedValue(successfulMutation(userSubject))
    renderPanel()
    await waitFor(() => expect(mockGetGfsGrants).toHaveBeenCalledTimes(1))
    const initialSignal = mockGetGfsGrants.mock.calls[0][2]
    await chooseSubjects('Ada Lovelace')
    selectPermission('Read')
    await submit('Grant access')

    const existing = await screen.findByRole('region', { name: 'Existing access' })
    expect(await within(existing).findByText('Grant · read · resource only')).toBeTruthy()
    expect(initialSignal?.aborted).toBe(true)
    resolveInitialGrants({ items: [] })

    await waitFor(() =>
      expect(within(existing).getByText('Grant · read · resource only')).toBeTruthy()
    )
    expect(within(existing).queryByText('No direct access configured.')).toBeNull()
  })

  it('aborts the active access hydration when the panel unmounts', async () => {
    mockGetGfsGrants.mockReturnValueOnce(new Promise(() => undefined))
    const panel = renderPanel()
    await waitFor(() => expect(mockGetGfsGrants).toHaveBeenCalledTimes(1))
    const signal = mockGetGfsGrants.mock.calls[0][2]

    panel.unmount()

    expect(signal?.aborted).toBe(true)
  })

  it('offers users, teams, canonical hosts, and singular operator without contexts', async () => {
    renderPanel()
    const listbox = await openSubjectPicker()

    expect(within(listbox).getByRole('option', { name: 'Ada Lovelace' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'Research' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'chatllm (Stateful)' })).toBeTruthy()
    expect(
      within(listbox).getByRole('option', { name: 'chatllm-stateless (Stateless)' })
    ).toBeTruthy()
    expect(within(listbox).queryByRole('option', { name: 'First-party agent runtime' })).toBeNull()
    expect(within(listbox).getByRole('option', { name: 'sandbox-ui-hello' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'Operator' })).toBeTruthy()
    expect(within(listbox).queryByRole('option', { name: /context/i })).toBeNull()
  })

  it('submits one ordered mixed bulk grant and enforces the host UI permission matrix', async () => {
    mockPutGfsGrant.mockResolvedValue(
      successfulMutation(
        userSubject,
        teamSubject,
        statefulHostSubject,
        statelessHostSubject,
        workflowHostSubject
      )
    )
    renderPanel()
    await chooseSubjects('Ada Lovelace', 'Research')
    selectPermission('Read')
    selectPermission('Delete')
    await chooseSubjects('chatllm (Stateful)', 'chatllm-stateless (Stateless)', 'sandbox-ui-hello')

    const permissions = openPermissionMenu()
    expect(within(permissions).getByRole('menuitemcheckbox', { name: 'Read' })).toBeChecked()
    expect(within(permissions).getByRole('menuitemcheckbox', { name: 'Write' })).not.toBeChecked()
    expect(within(permissions).queryByRole('menuitemcheckbox', { name: 'Delete' })).toBeNull()
    expect(within(permissions).queryByRole('menuitemcheckbox', { name: 'Share' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDisabled()

    await submit('Grant access')

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: resource.resourceId,
        subjects: [
          { type: 'user', id: '11111111-1111-1111-1111-111111111111' },
          { type: 'team', id: '22222222-2222-2222-2222-222222222222' },
          { type: 'host', id: '1st:mcp-host/chatllm' },
          { type: 'host', id: '1st:mcp-host/chatllm-stateless' },
          { type: 'host', id: '3rd:sandbox-recipes/sandbox-ui-hello' },
        ],
        permissions: ['read'],
        inherit: false,
      })
    )
    await waitFor(() => expect(mockGetGfsGrants).toHaveBeenCalledTimes(2))
  })

  it('creates one bulk share for user and team subjects', async () => {
    mockPostGfsShare.mockResolvedValue(successfulMutation(userSubject, teamSubject))
    renderPanel()
    await chooseSubjects('Ada Lovelace', 'Research')
    selectPermission('Read')
    await submit('Create share')

    await waitFor(() =>
      expect(mockPostGfsShare).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: resource.resourceId,
        subjects: [
          { type: 'user', id: '11111111-1111-1111-1111-111111111111' },
          { type: 'team', id: '22222222-2222-2222-2222-222222222222' },
        ],
        permissions: ['read'],
        includeDescendants: false,
      })
    )
  })

  it('keeps operator singular and prevents mixing it with bulk subjects', async () => {
    mockPutGfsGrant.mockResolvedValue(successfulMutation(operatorSubject))
    renderPanel()
    await chooseSubjects('Ada Lovelace', 'Operator')

    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Operator' })).toBeTruthy()
    selectPermission('Read')
    await submit('Grant access')

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: resource.resourceId,
        subject: { type: 'operator' },
        permissions: ['read'],
        inherit: false,
      })
    )
  })

  it('preserves the form after rejection and resets it only after success', async () => {
    mockPutGfsGrant
      .mockRejectedValueOnce(
        Object.assign(new Error('403 escalation_rejected'), {
          code: 'escalation_rejected',
          serverMessage: 'Requested permissions exceed operator authority.',
          invalidIndexes: [1],
        })
      )
      .mockResolvedValueOnce(successfulMutation(userSubject, teamSubject))
    renderPanel()
    await chooseSubjects('Ada Lovelace', 'Research')
    selectPermission('Write')
    await submit('Grant access')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'escalation_rejected: Requested permissions exceed operator authority. (invalid indexes: 1)'
    )
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Research' })).toBeTruthy()
    expect(document.querySelector('.cu-gfs-permission-dropdown__trigger')).toHaveTextContent(
      'Write'
    )

    await submit('Grant access')
    await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull()
    expect(document.querySelector('.cu-gfs-permission-dropdown__trigger')).toHaveTextContent(
      'Permissions'
    )
  })

  it('does not duplicate the machine code when the server message matches it', async () => {
    mockPutGfsGrant.mockRejectedValue(
      Object.assign(new Error('400 subjects_invalid'), {
        code: 'subjects_invalid',
        serverMessage: 'subjects_invalid',
      })
    )
    renderPanel()
    await chooseSubjects('Ada Lovelace')
    selectPermission('Read')
    await submit('Grant access')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('subjects_invalid')
    expect(alert).not.toHaveTextContent('subjects_invalid: subjects_invalid')
  })

  it('does not restore incompatible permissions after the final host is removed', async () => {
    renderPanel()
    await chooseSubjects('Ada Lovelace')
    selectPermission('Delete')
    await chooseSubjects('chatllm (Stateful)')

    expect(
      within(openPermissionMenu()).queryByRole('menuitemcheckbox', { name: 'Delete' })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove chatllm (Stateful)' }))

    expect(
      within(openPermissionMenu()).getByRole('menuitemcheckbox', { name: 'Delete' })
    ).not.toBeChecked()
    selectPermission('Read')
    expect(screen.getByRole('button', { name: 'Create share' })).toBeEnabled()
  })

  it('caps the UI selection at 100 subjects', async () => {
    mockGetAdminUsers.mockResolvedValue({
      items: Array.from({ length: 101 }, (_, index) => ({
        id: `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
        email: `user-${index + 1}@example.test`,
        name: `Bulk User ${String(index + 1).padStart(3, '0')}`,
        displayName: `Bulk User ${String(index + 1).padStart(3, '0')}`,
        picture: null,
        activeTeamCount: 0,
      })),
    })
    renderPanel()
    const listbox = await openSubjectPicker()
    for (let index = 1; index <= 101; index += 1) {
      const option = listbox.querySelector<HTMLButtonElement>('[role="option"]')
      expect(option).not.toBeNull()
      fireEvent.click(option!)
    }

    expect(await screen.findByRole('alert')).toHaveTextContent('You can select up to 100 subjects.')
    expect(screen.getAllByRole('button', { name: /^Remove Bulk User/ })).toHaveLength(100)
    expect(screen.queryByRole('button', { name: 'Remove Bulk User 101' })).toBeNull()
  }, 15_000)
})
