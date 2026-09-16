import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  deleteGfsGrant,
  getAdminTeams,
  getAdminUsers,
  getGfsGrants,
  getGfsResourceByPath,
  getGfsShares,
  getHosts,
  getRecipes,
  putGfsGrant,
} from '@lib/api'
import { GfsGrantPanel } from '../GfsGrantPanel'
import { ToastProvider } from '../Toast'
import { gfsAncestorPaths } from '../gfsInheritedAccess'

vi.mock('@lib/api', () => ({
  getAdminTeams: vi.fn(),
  getAdminUsers: vi.fn(),
  getHosts: vi.fn(),
  getRecipes: vi.fn(),
  getGfsGrants: vi.fn(),
  getGfsShares: vi.fn(),
  getGfsResourceByPath: vi.fn(),
  deleteGfsGrant: vi.fn(),
  deleteGfsShare: vi.fn(),
  putGfsGrant: vi.fn(),
}))

const mockGetAdminUsers = vi.mocked(getAdminUsers)
const mockGetAdminTeams = vi.mocked(getAdminTeams)
const mockGetHosts = vi.mocked(getHosts)
const mockGetRecipes = vi.mocked(getRecipes)
const mockGetGfsGrants = vi.mocked(getGfsGrants)
const mockGetGfsShares = vi.mocked(getGfsShares)
const mockGetGfsResourceByPath = vi.mocked(getGfsResourceByPath)
const mockPutGfsGrant = vi.mocked(putGfsGrant)
const mockDeleteGfsGrant = vi.mocked(deleteGfsGrant)

const FILE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const FOLDER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ROOT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const fileResource = {
  resourceId: FILE_ID,
  name: 'report.md',
  gfsUri: 'gfs://main/report',
  kind: 'file',
  path: '/team-docs/report.md',
}

const folderResource = {
  resourceId: FOLDER_ID,
  name: 'team-docs',
  gfsUri: 'gfs://main/team-docs',
  kind: 'directory',
  path: '/team-docs',
}

const miguel = { type: 'user', id: '11111111-1111-1111-1111-111111111111' } as const
const marcela = { type: 'user', id: '22222222-2222-2222-2222-222222222222' } as const
const researchTeam = { type: 'team', id: '33333333-3333-3333-3333-333333333333' } as const

const FOLDER_GRANT_ID = '44444444-4444-4444-4444-444444444444'
const ROOT_SHARE_ID = '66666666-6666-6666-6666-666666666666'
const FILE_GRANT_ID = '77777777-7777-7777-7777-777777777777'

function byPathView(resourceId: string, name: string) {
  return {
    resourceId,
    rid: resourceId.replace(/-/g, ''),
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    name,
    kind: 'directory',
    path: name ? `/${name}` : '/',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function renderPanel(resource = fileResource) {
  return render(
    <ToastProvider>
      <GfsGrantPanel resource={resource} />
    </ToastProvider>
  )
}

/** Opens the row's role dropdown and picks a role option. */
async function chooseRole(row: HTMLElement, option: 'Read' | 'Editor') {
  const trigger = within(row).getByRole('button', { name: /Access role for/ })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

describe('GfsGrantPanel inherited access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAdminUsers.mockResolvedValue({
      items: [
        {
          id: miguel.id,
          email: 'miguel@example.test',
          name: 'Miguel',
          displayName: 'Miguel',
          picture: null,
          activeTeamCount: 1,
        },
        {
          id: marcela.id,
          email: 'marcela@example.test',
          name: 'Marcela',
          displayName: 'Marcela',
          picture: null,
          activeTeamCount: 1,
        },
      ],
    })
    mockGetAdminTeams.mockResolvedValue({
      items: [{ id: researchTeam.id, name: 'Research', memberCount: 2 }],
    })
    mockGetHosts.mockResolvedValue({ items: [] })
    mockGetRecipes.mockResolvedValue({ items: [] })
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: FOLDER_GRANT_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
              inherit: true,
            },
            {
              id: '55555555-5555-5555-5555-555555555555',
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: marcela,
              permissions: ['read'],
              inherit: false,
            },
          ],
        }
      }
      return { items: [] }
    })
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === ROOT_ID) {
        return {
          items: [
            {
              id: ROOT_SHARE_ID,
              drive: 'main',
              resourceId: ROOT_ID,
              subject: researchTeam,
              permissions: ['read'],
              includeDescendants: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/team-docs') return byPathView(FOLDER_ID, 'team-docs')
      if (path === '/') return byPathView(ROOT_ID, '')
      throw Object.assign(new Error('404 not_found'), { status: 404 })
    })
    mockPutGfsGrant.mockResolvedValue({ ok: true, resourceId: FILE_ID, updated: [], count: 0 })
    mockDeleteGfsGrant.mockResolvedValue(undefined)
  })

  it('derives ancestor folder paths nearest first', () => {
    expect(gfsAncestorPaths('/a/b/c/report.md')).toEqual(['/a/b/c', '/a/b', '/a', '/'])
    expect(gfsAncestorPaths('/report.md')).toEqual(['/'])
    expect(gfsAncestorPaths('/')).toEqual([])
  })

  it('shows inherited members as normal toggleable rows with their strongest role', async () => {
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId('gfs-access-row-user')
    expect(within(miguelRow).getAllByText('Miguel')).toHaveLength(1)
    // Normal-looking row: role dropdown and actions menu, no inherited badge
    // or muted duplicate.
    expect(
      within(miguelRow).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')
    expect(within(miguelRow).getByRole('button', { name: 'Actions for Miguel' })).toBeTruthy()
    expect(within(miguelRow).queryByText(/Inherited from/)).toBeNull()
    expect(miguelRow.className).not.toContain('inherited')

    // The root share covers descendants too, and the drive root's empty name
    // falls back to the drive label.
    const teamRow = within(existing).getByTestId('gfs-access-row-team')
    expect(within(teamRow).getByText('Research')).toBeTruthy()
    expect(
      within(teamRow).getByRole('button', { name: 'Access role for Research' }).textContent
    ).toContain('Read')

    // A non-inheriting ancestor grant applies to the folder only — never a row.
    expect(within(existing).queryByText('Marcela')).toBeNull()
  })

  it('dedupes a member with both a direct grant and inherited access into one row', async () => {
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === FILE_ID) {
        return {
          items: [
            {
              id: FILE_GRANT_ID,
              drive: 'main',
              resourceId: FILE_ID,
              subject: miguel,
              permissions: ['read', 'share'],
              inherit: false,
            },
          ],
        }
      }
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: FOLDER_GRANT_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              inherit: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const rows = await within(existing).findAllByTestId('gfs-access-row-user')
    expect(rows).toHaveLength(1)
    // Effective role is the strongest across direct and inherited sources.
    expect(
      within(rows[0]).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')
  })

  it('opens the parent-folder confirmation on any role change of an inherited row', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId('gfs-access-row-user')

    await chooseRole(miguelRow, 'Read')

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Update role on parent folder?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        "Changing Miguel's permissions on this item will also change permissions on a parent folder. Alternatively, create a folder with limited access."
      )
    ).toBeTruthy()
    expect(within(dialog).getByText('Learn more')).toBeTruthy()
    // Two-column before/after: parent folder and file, current -> new role.
    expect(within(dialog).getByText('team-docs')).toBeTruthy()
    expect(within(dialog).getByText('report.md')).toBeTruthy()
    expect(within(dialog).getAllByText('Editor')).toHaveLength(2)
    expect(within(dialog).getAllByText('Read')).toHaveLength(2)
  })

  it('applies a confirmed role change to the parent folder grant and keeps the file aligned', async () => {
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === FILE_ID) {
        return {
          items: [
            {
              id: FILE_GRANT_ID,
              drive: 'main',
              resourceId: FILE_ID,
              subject: miguel,
              permissions: ['read', 'share'],
              inherit: false,
            },
          ],
        }
      }
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: FOLDER_GRANT_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              inherit: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId('gfs-access-row-user')

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(2))
    // The parent folder's grant is updated first and keeps cascading.
    expect(mockPutGfsGrant).toHaveBeenNthCalledWith(1, {
      drive: 'main',
      resourceId: FOLDER_ID,
      subject: miguel,
      permissions: ['read', 'share'],
      inherit: true,
    })
    // The file's own direct grant is aligned so it cannot mask the new role.
    expect(mockPutGfsGrant).toHaveBeenNthCalledWith(2, {
      drive: 'main',
      resourceId: FILE_ID,
      subject: miguel,
      permissions: ['read', 'share'],
      inherit: false,
    })
  })

  it('cancel reverts the dropdown without any API call', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId('gfs-access-row-user')

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mockPutGfsGrant).not.toHaveBeenCalled()
    expect(
      within(miguelRow).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')
  })

  it('removes an inherited member from the parent folder after confirmation', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId('gfs-access-row-user')

    fireEvent.click(within(miguelRow).getByRole('button', { name: 'Actions for Miguel' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Remove access on parent folder?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        "Removing Miguel's access to this item will also remove their access on a parent folder. Alternatively, create a folder with limited access."
      )
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(mockDeleteGfsGrant).toHaveBeenCalledWith(FOLDER_GRANT_ID))
  })

  it('opens the help panel from Learn more and returns to the confirmation', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId('gfs-access-row-user')

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn more' }))

    const help = await screen.findByRole('alertdialog')
    expect(within(help).getByText('How sharing works in EvenDrive')).toBeTruthy()
    expect(
      within(help).getByText(
        "You can't give someone less access on a single file than they have on its parent folder."
      )
    ).toBeTruthy()
    expect(within(help).getByText(/create a folder with limited access/)).toBeTruthy()

    fireEvent.click(within(help).getByRole('button', { name: 'Back' }))
    expect(await within(screen.getByRole('alertdialog')).getByText('Update role on parent folder?'))
  })

  it('keeps direct-only rows on the old direct path (change applies to the file)', async () => {
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === FILE_ID) {
        return {
          items: [
            {
              id: FILE_GRANT_ID,
              drive: 'main',
              resourceId: FILE_ID,
              subject: marcela,
              permissions: ['read', 'share'],
              inherit: false,
            },
          ],
        }
      }
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: FOLDER_GRANT_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              inherit: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const marcelaRow = within(existing)
      .getAllByTestId('gfs-access-row-user')
      .find(row => within(row).queryByText('Marcela') !== null)
    expect(marcelaRow).toBeTruthy()

    await chooseRole(marcelaRow as HTMLElement, 'Editor')
    // Direct row: no confirmation modal, the file grant is updated directly.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FILE_ID,
        subject: marcela,
        permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
        inherit: false,
      })
    )
  })

  it('keeps folder dialogs unchanged: direct rows only, no derived ancestor rows', async () => {
    renderPanel(folderResource)

    const existing = await screen.findByRole('region', { name: 'People with access' })
    // The folder's own direct rows render, toggleable as before.
    const miguelRow = (await within(existing).findAllByTestId('gfs-access-row-user')).find(
      row => within(row).queryByText('Miguel') !== null
    )
    expect(miguelRow).toBeTruthy()
    expect(
      within(miguelRow as HTMLElement).getByRole('button', { name: 'Access role for Miguel' })
        .textContent
    ).toContain('Editor')
    expect(within(miguelRow as HTMLElement).queryByText(/Inherited from/)).toBeNull()
    // Ancestor derivation never runs for folders.
    await waitFor(() => expect(mockGetGfsResourceByPath).not.toHaveBeenCalled())
    expect(within(existing).queryByText('Research')).toBeNull()
  })

  it('skips derivation when the resource has no path and hides no direct rows', async () => {
    renderPanel({ ...fileResource, path: null })

    const existing = await screen.findByRole('region', { name: 'People with access' })
    await waitFor(() => expect(within(existing).getByText('No one has access yet.')).toBeTruthy())
    expect(mockGetGfsResourceByPath).not.toHaveBeenCalled()
  })

  it('merges the same subject inherited through several folders into one row with the strongest source', async () => {
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/team-docs') return byPathView(FOLDER_ID, 'team-docs')
      if (path === '/') return byPathView(ROOT_ID, '')
      throw Object.assign(new Error('404 not_found'), { status: 404 })
    })
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === FOLDER_ID || resourceId === ROOT_ID) {
        return {
          items: [
            {
              id: `g-${resourceId}`,
              drive: 'main',
              resourceId,
              subject: miguel,
              permissions: resourceId === FOLDER_ID ? ['read', 'write'] : ['read'],
              inherit: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const rows = await within(existing).findAllByTestId('gfs-access-row-user')
    expect(rows).toHaveLength(1)
    expect(
      within(rows[0]).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')

    // A confirmed change routes to the strongest contributing folder.
    await chooseRole(rows[0], 'Read')
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('team-docs')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))
    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: FOLDER_ID, inherit: true })
      )
    )
  })
})
