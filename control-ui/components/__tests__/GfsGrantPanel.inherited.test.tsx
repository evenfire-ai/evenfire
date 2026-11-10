import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  apiGet,
  deleteGfsGrant,
  deleteGfsShare,
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
  apiGet: vi.fn(),
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

const mockApiGet = vi.mocked(apiGet)
const mockGetAdminUsers = vi.mocked(getAdminUsers)
const mockGetAdminTeams = vi.mocked(getAdminTeams)
const mockGetHosts = vi.mocked(getHosts)
const mockGetRecipes = vi.mocked(getRecipes)
const mockGetGfsGrants = vi.mocked(getGfsGrants)
const mockGetGfsShares = vi.mocked(getGfsShares)
const mockGetGfsResourceByPath = vi.mocked(getGfsResourceByPath)
const mockPutGfsGrant = vi.mocked(putGfsGrant)
const mockDeleteGfsGrant = vi.mocked(deleteGfsGrant)
const mockDeleteGfsShare = vi.mocked(deleteGfsShare)

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
const miguelRowTestId = `gfs-access-row-user:${miguel.id}`
const marcelaRowTestId = `gfs-access-row-user:${marcela.id}`
const researchTeamRowTestId = `gfs-access-row-team:${researchTeam.id}`

function byPathView(resourceId: string, name: string) {
  return {
    resourceId,
    rid: resourceId.replace(/-/g, ''),
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    name,
    kind: 'directory',
    path: name ? `/${name}` : '/',
    version: 1,
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
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
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
    const teamRow = within(existing).getByTestId(researchTeamRowTestId)
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
    const rows = await within(existing).findAllByTestId(miguelRowTestId)
    expect(rows).toHaveLength(1)
    // Effective role is the strongest across direct and inherited sources.
    expect(
      within(rows[0]).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')
  })

  it('opens the parent-folder confirmation on any role change of an inherited row', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

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
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

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
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mockPutGfsGrant).not.toHaveBeenCalled()
    expect(
      within(miguelRow).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')
  })

  // RP-032 — a confirmed role change rewrites the folder's GRANT (with its
  // own scope flag) and revokes the sharing entry that still grants Editor,
  // so a Read downgrade cannot leave effective Editor access through a link.
  it('revokes the folder’s conflicting sharing entry on a confirmed role change', async () => {
    const FOLDER_SHARE_ID = '88888888-8888-8888-8888-888888888888'
    mockGetGfsGrants.mockImplementation(async resourceId => {
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
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: FOLDER_SHARE_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              includeDescendants: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FOLDER_ID,
        subject: miguel,
        permissions: ['read', 'share'],
        inherit: true,
      })
    )
    // The sharing entry that still granted Editor is revoked with the change.
    await waitFor(() => expect(mockDeleteGfsShare).toHaveBeenCalledWith(FOLDER_SHARE_ID))
    // The honest outcome names the revoked entry and claims no residual.
    expect(
      await screen.findByText(
        'Changed grant access to Read-only on team-docs. The sharing entry on team-docs was revoked.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/still grant Editor access/)).toBeNull()
  })

  // RP-032 — conflicting-only: on the rewritten folder the Editor sharing
  // entry goes, the Read sharing entry stays (with its own descendant
  // coverage), and neither entry is touched on any other resource.
  it('revokes only the conflicting sharing entry on the rewritten folder', async () => {
    const EDITOR_SHARE_ID = '14141414-1414-4141-8141-141414141414'
    const READ_SHARE_ID = '15151515-1515-4151-8151-151515151515'
    mockGetGfsGrants.mockImplementation(async resourceId => {
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
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: EDITOR_SHARE_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              includeDescendants: true,
            },
            {
              id: READ_SHARE_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read'],
              includeDescendants: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    await waitFor(() => expect(mockDeleteGfsShare).toHaveBeenCalledWith(EDITOR_SHARE_ID))
    // The Read entry already grants the target role: it is not a conflict and
    // survives, with its own descendant coverage intact.
    expect(mockDeleteGfsShare).not.toHaveBeenCalledWith(READ_SHARE_ID)
    expect(mockDeleteGfsShare).toHaveBeenCalledTimes(1)
  })

  // RP-032 — a revocation that fails mid-cascade is a PARTIAL outcome: the
  // folders already written stay written, the folder whose sharing entry
  // could not be revoked keeps granting Editor, and the copy says exactly
  // how far the change got.
  it('states the true partial outcome when a folder sharing entry cannot be revoked', async () => {
    const EDITOR_SHARE_ID = '16161616-1616-4161-8161-161616161616'
    mockGetGfsGrants.mockImplementation(async resourceId => {
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
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: EDITOR_SHARE_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              includeDescendants: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    mockDeleteGfsShare.mockRejectedValueOnce(
      Object.assign(new Error('403 share_revocation_rejected'), {
        status: 403,
        code: 'share_revocation_rejected',
        serverMessage: 'share_revocation_rejected',
      })
    )
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

    await chooseRole(miguelRow, 'Read')
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    // The folder's GRANT was rewritten, but its sharing entry survived: the
    // outcome says so instead of claiming the member lost Editor access.
    expect(
      await screen.findByText(
        'Updated 1 of 1 folders — a sharing entry on team-docs could not be revoked, so Editor access may remain.'
      )
    ).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('share_revocation_rejected')
  })

  // RP-032 — a sharing entry that is ALREADY GONE grants nothing: the
  // outcome is the one a successful delete produced, so the panel must not
  // claim residual Editor access that cannot exist.
  it('does not report residual Editor access when the sharing entry is already gone', async () => {
    const FILE_SHARE_ID = '17171717-1717-4171-8171-171717171717'
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                inherit: false,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    mockDeleteGfsShare.mockRejectedValueOnce(
      Object.assign(new Error('404 share_not_found'), {
        status: 404,
        code: 'share_not_found',
        serverMessage: 'share_not_found',
      })
    )
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(miguelRow, 'Read')

    expect(
      await screen.findByText(
        'Changed grant access to Read-only on report.md. The sharing entry on report.md was revoked.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/could not be revoked/)).toBeNull()
    expect(screen.queryByText(/still grant Editor access/)).toBeNull()
  })

  // R1-M5 — a share-only ancestor is never converted into a grant: nothing
  // is written, the confirmation never opens, and the user is told why.
  it('refuses a share-only ancestor role change without creating a grant', async () => {
    const FOLDER_SHARE_ID = '99999999-9999-9999-9999-999999999999'
    mockGetGfsGrants.mockImplementation(async () => ({ items: [] }))
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === FOLDER_ID) {
        return {
          items: [
            {
              id: FOLDER_SHARE_ID,
              drive: 'main',
              resourceId: FOLDER_ID,
              subject: miguel,
              permissions: ['read', 'write'],
              includeDescendants: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

    await chooseRole(miguelRow, 'Read')

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mockPutGfsGrant).not.toHaveBeenCalled()
    expect(mockDeleteGfsShare).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        /still has Editor access from sharing entries that can't be edited here/
      )
    ).toBeTruthy()
  })

  // RP-032 — a role change rewrites the folder's GRANT row and revokes the
  // folder's SHARE row that still grants Editor, so nothing survives on that
  // folder. The confirmation must NOT claim a surviving Editor there.
  it('claims no surviving Editor on a folder whose sharing entry is revoked', async () => {
    const FOLDER_SHARE_ID = '77777777-7777-4777-8777-777777777777'
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FOLDER_ID
          ? [
              {
                id: FOLDER_GRANT_ID,
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                inherit: true,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FOLDER_ID
          ? [
              {
                id: FOLDER_SHARE_ID,
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(miguelRow, 'Read')

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByText(/still grant Editor access/)).toBeNull()
    expect(mockPutGfsGrant).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    await waitFor(() => expect(mockDeleteGfsShare).toHaveBeenCalledWith(FOLDER_SHARE_ID))
  })

  // RP-011 — when only the direct grant can be rewritten, the access the
  // member keeps through the shares this panel cannot edit is disclosed in a
  // confirmation BEFORE the write, not only in the post-change feedback.
  it('discloses inherited Editor shares before the direct grant is changed', async () => {
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                inherit: false,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FOLDER_ID
          ? [
              {
                id: ROOT_SHARE_ID,
                drive: 'main',
                resourceId: FOLDER_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const row = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(row, 'Read')

    // The confirmation opens BEFORE anything is written, and it names the
    // Editor access the change does not remove.
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(
        'Sharing entries on team-docs still grant Editor access. This change does not remove them.'
      )
    ).toBeTruthy()
    expect(within(dialog).getByText(/changes this item's own access only/)).toBeTruthy()
    expect(mockPutGfsGrant).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FILE_ID,
        subject: miguel,
        permissions: ['read', 'share'],
        inherit: false,
      })
    )
    expect(mockPutGfsGrant).toHaveBeenCalledTimes(1)
    // Nothing is revoked here: the item carries no sharing entry of its own,
    // and the share-only ancestor's entry is not one this panel may rewrite.
    // It survives and is disclosed in the outcome.
    expect(mockDeleteGfsShare).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Changed grant access to Read-only on report.md. Sharing entries on team-docs still grant Editor access.'
      )
    ).toBeTruthy()
  })

  // RP-032 — a Read downgrade must not leave effective Editor access through
  // a link: the sharing entry on the item itself is revoked with the grant
  // write, because the server has no share-update surface.
  it('revokes the item’s conflicting sharing entry when its role is downgraded', async () => {
    const FILE_SHARE_ID = 'abababab-abab-4bab-8bab-abababababab'
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                inherit: false,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(miguelRow, 'Read')

    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FILE_ID,
        subject: miguel,
        permissions: ['read', 'share'],
        inherit: false,
      })
    )
    await waitFor(() => expect(mockDeleteGfsShare).toHaveBeenCalledWith(FILE_SHARE_ID))
    expect(
      await screen.findByText(
        'Changed grant access to Read-only on report.md. The sharing entry on report.md was revoked.'
      )
    ).toBeTruthy()
  })

  // RP-032 — only a CONFLICTING sharing entry is revoked: an entry that
  // already grants the target role is not a conflict and survives.
  it('keeps a sharing entry that already grants the target role', async () => {
    const FILE_SHARE_ID = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                inherit: false,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(miguelRow, 'Read')

    await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(1))
    expect(mockDeleteGfsShare).not.toHaveBeenCalled()
    expect(await screen.findByText('Miguel is now Read-only.')).toBeTruthy()
  })

  // RP-032 — an UPGRADE revokes nothing: a Read sharing entry AND an Editor
  // sharing entry both survive, so raising the grant never drops access the
  // operator did not ask to drop. The grant's OWN scope flag is preserved.
  it('keeps both a Read sharing entry and an Editor sharing entry on an upgrade to Editor', async () => {
    const READ_SHARE_ID = '12121212-1212-4121-8121-121212121212'
    const EDITOR_SHARE_ID = '13131313-1313-4131-8131-131313131313'
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: marcela,
                permissions: ['read'],
                inherit: false,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: READ_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: marcela,
                permissions: ['read'],
                includeDescendants: true,
              },
              {
                id: EDITOR_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: marcela,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const marcelaRow = await within(existing).findByTestId(marcelaRowTestId)
    await chooseRole(marcelaRow, 'Editor')

    // The grant is raised to Editor with its OWN scope flag (false) — the
    // shares' includeDescendants is never OR'd into the grant write.
    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FILE_ID,
        subject: marcela,
        permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
        inherit: false,
      })
    )
    // Neither sharing entry conflicts with the target role, so neither is
    // revoked: the Read entry keeps its descendant coverage and the Editor
    // entry survives the upgrade.
    expect(mockDeleteGfsShare).not.toHaveBeenCalled()
  })

  // RP-032 — the INVERSE combination: an inherited Editor grant plus a
  // DIRECT Editor share on the opened item, with no direct grant. The
  // downgrade rewrites the ancestor grant and (by the accepted semantics)
  // preserves the direct share-only access — so the member keeps Editor
  // access through it. The operator must be told BEFORE approving, and the
  // outcome must repeat it.
  it('discloses the surviving direct Editor share before and after the downgrade', async () => {
    const DIRECT_SHARE_ID = '18181818-1818-4181-8181-181818181818'
    mockGetGfsGrants.mockImplementation(async resourceId => {
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
      // No direct grant on the opened item: its access is the share below.
      return { items: [] }
    })
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: DIRECT_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(miguelRow, 'Read')

    // CONSENT: the confirmation names the access that survives the change.
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(
        'Sharing entries on report.md still grant Editor access. This change does not remove them.'
      )
    ).toBeTruthy()
    expect(mockPutGfsGrant).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

    // The ancestor grant is rewritten…
    await waitFor(() =>
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FOLDER_ID,
        subject: miguel,
        permissions: ['read', 'share'],
        inherit: true,
      })
    )
    // …the share-only direct row is neither converted nor revoked…
    expect(mockPutGfsGrant).toHaveBeenCalledTimes(1)
    expect(mockDeleteGfsShare).not.toHaveBeenCalledWith(DIRECT_SHARE_ID)
    // …and the outcome repeats the residual Editor access.
    expect(
      await screen.findByText(
        'Changed grant access to Read-only on team-docs. Sharing entries on report.md still grant Editor access.'
      )
    ).toBeTruthy()
  })

  // RP-032 — a revocation that fails is a PARTIAL outcome: the role changed,
  // but the link may still grant Editor, and the copy must say so.
  it('states the true partial outcome when a sharing entry cannot be revoked', async () => {
    const FILE_SHARE_ID = 'efefefef-efef-4fef-8fef-efefefefefef'
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                inherit: false,
              },
            ]
          : [],
    }))
    mockGetGfsShares.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_SHARE_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: ['read', 'write'],
                includeDescendants: true,
              },
            ]
          : [],
    }))
    mockDeleteGfsShare.mockRejectedValueOnce(
      Object.assign(new Error('403 share_revocation_rejected'), {
        status: 403,
        code: 'share_revocation_rejected',
        serverMessage: 'share_revocation_rejected',
      })
    )
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)
    await chooseRole(miguelRow, 'Read')

    expect(
      await screen.findByText(
        'Changed grant access to Read-only on report.md. A sharing entry could not be revoked, so Editor access may remain.'
      )
    ).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('share_revocation_rejected')
  })

  // A role promise is only as good as the coverage it was made under: an
  // ancestor the operator cannot see may still grant Editor, so the success
  // copy must say what was NOT verified instead of promising an effective
  // role.
  it('qualifies the role-change toast when the inherited coverage is incomplete', async () => {
    const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
    const text = JSON.stringify({ error: 'request_failed', message: 'parent read failed' })
    const error = actual.formatApiError(new Response(text, { status: 403 }), text)
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/team-docs') return byPathView(FOLDER_ID, 'team-docs')
      throw error
    })
    mockGetGfsGrants.mockImplementation(async resourceId => ({
      items:
        resourceId === FILE_ID
          ? [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: marcela,
                permissions: ['read', 'write'],
                inherit: false,
              },
            ]
          : [],
    }))
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const row = await within(existing).findByTestId(marcelaRowTestId)
    await chooseRole(row, 'Read')

    await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByText(
        'Marcela is now Read-only. Access through parent folders you cannot see was not verified.'
      )
    ).toBeTruthy()
  })

  // R1-M5 — a share-only DIRECT row is not role-editable: the dropdown is
  // disabled (no grant would be created by a role change).
  it('disables the role dropdown for a share-only direct row', async () => {
    const FILE_SHARE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    mockGetGfsGrants.mockImplementation(async () => ({ items: [] }))
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === FILE_ID) {
        return {
          items: [
            {
              id: FILE_SHARE_ID,
              drive: 'main',
              resourceId: FILE_ID,
              subject: marcela,
              permissions: ['read', 'write'],
              includeDescendants: false,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const marcelaRow = await within(existing).findByTestId(marcelaRowTestId)
    const trigger = within(marcelaRow).getByRole('button', { name: 'Access role for Marcela' })
    expect(trigger.hasAttribute('disabled')).toBe(true)
    // A disabled dropdown never opens, so no role selection — and no grant
    // write — can originate from a share-only direct row.
    fireEvent.click(trigger)
    expect(screen.queryByRole('option', { name: 'Editor' })).toBeNull()
    await waitFor(() => expect(mockPutGfsGrant).not.toHaveBeenCalled())
  })

  // R1-M5 — a direct role write preserves the GRANT row's own scope flag
  // (never the OR with share coverage) and keeps the share rows.
  it('preserves the direct grant’s own inherit flag and its share rows on a role change', async () => {
    const FILE_SHARE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    mockGetGfsGrants.mockImplementation(async resourceId => {
      if (resourceId === FILE_ID) {
        return {
          items: [
            {
              id: FILE_GRANT_ID,
              drive: 'main',
              resourceId: FILE_ID,
              subject: marcela,
              permissions: ['read'],
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
    mockGetGfsShares.mockImplementation(async resourceId => {
      if (resourceId === FILE_ID) {
        return {
          items: [
            {
              id: FILE_SHARE_ID,
              drive: 'main',
              resourceId: FILE_ID,
              subject: marcela,
              permissions: ['read'],
              includeDescendants: true,
            },
          ],
        }
      }
      return { items: [] }
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const marcelaRow = within(existing)
      .getAllByTestId(marcelaRowTestId)
      .find(row => within(row).queryByText('Marcela') !== null)
    await chooseRole(marcelaRow as HTMLElement, 'Editor')

    // Direct row: no confirmation modal, the file grant is updated directly —
    // with the grant's OWN inherit flag (false), not the OR'd union.
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
    expect(mockDeleteGfsShare).not.toHaveBeenCalled()
  })

  it('removes an inherited member from the parent folder after confirmation', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

    fireEvent.click(within(miguelRow).getByRole('button', { name: 'Actions for Miguel' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Remove from parent folder?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        /Removing Miguel from this item will also remove them from a parent folder\. Alternatively, create a folder with limited access\./
      )
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(mockDeleteGfsGrant).toHaveBeenCalledWith(FOLDER_GRANT_ID))
  })

  it('opens the help panel from Learn more and returns to the confirmation', async () => {
    renderPanel()
    const existing = await screen.findByRole('region', { name: 'People with access' })
    const miguelRow = await within(existing).findByTestId(miguelRowTestId)

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
    expect(within(existing).getByTestId(miguelRowTestId)).toBeTruthy()
    expect(within(existing).getByTestId(marcelaRowTestId)).toBeTruthy()
    const marcelaRow = within(existing)
      .getAllByTestId(marcelaRowTestId)
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

  it('derives inherited ancestor rows for FOLDER dialogs too', async () => {
    renderPanel(folderResource)

    const existing = await screen.findByRole('region', { name: 'People with access' })
    // The folder's own direct rows render, toggleable as before.
    const miguelRow = (await within(existing).findAllByTestId(miguelRowTestId)).find(
      row => within(row).queryByText('Miguel') !== null
    )
    expect(miguelRow).toBeTruthy()
    expect(
      within(miguelRow as HTMLElement).getByRole('button', { name: 'Access role for Miguel' })
        .textContent
    ).toContain('Editor')
    expect(within(miguelRow as HTMLElement).queryByText(/Inherited from/)).toBeNull()
    // The folder's only ancestor is the drive root; its descendant-covering
    // share now shows as a normal inherited row — the reported folder bug.
    const teamRow = await within(existing).findByTestId(researchTeamRowTestId)
    expect(
      within(teamRow).getByRole('button', { name: 'Access role for Research' }).textContent
    ).toContain('Read')
    expect(within(teamRow).queryByText(/Inherited from/)).toBeNull()
    expect(mockGetGfsResourceByPath).toHaveBeenCalledWith('main', '/', expect.anything())
  })

  it('resolves the target once when the dialog resource carries no path', async () => {
    mockApiGet.mockResolvedValue({
      resourceId: FILE_ID,
      path: '/team-docs/report.md',
      kind: 'file',
    })
    renderPanel({ ...fileResource, path: null })

    const existing = await screen.findByRole('region', { name: 'People with access' })
    await within(existing).findByTestId(miguelRowTestId)
    expect(mockApiGet).toHaveBeenCalledWith(
      '/api/v1/gfs/resolve',
      { uri: fileResource.gfsUri },
      expect.anything()
    )
    expect(mockGetGfsResourceByPath).toHaveBeenCalledWith('main', '/team-docs', expect.anything())
  })

  // R1-M3 — a total derivation failure is a quiet inline notice, never a
  // silent "no one has access".
  it('shows a quiet notice when the inherited derivation fails entirely', async () => {
    mockGetGfsResourceByPath.mockImplementation(async () => {
      throw Object.assign(new Error('503 unavailable'), { status: 503 })
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    expect(
      await within(existing).findByText(
        'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
      )
    ).toBeTruthy()
    expect(within(existing).queryByText('No one has access yet.')).toBeNull()
    expect(within(existing).getByRole('status').textContent).toContain(
      'Inherited access could not be loaded'
    )
  })

  // A failed derivation is a FAILURE, not an observation: it must never be
  // cached as if it were authoritative. Reopening Share re-runs the walk.
  it('retries an unavailable inherited derivation when Share is reopened', async () => {
    mockGetGfsResourceByPath.mockImplementation(async () => {
      throw Object.assign(new Error('503 unavailable'), { status: 503 })
    })
    const first = renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    expect(
      await within(existing).findByText(
        'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
      )
    ).toBeTruthy()
    const callsAfterFirstOpen = mockGetGfsResourceByPath.mock.calls.length
    expect(callsAfterFirstOpen).toBeGreaterThan(0)

    // Closing Share unmounts the panel; reopening it walks the ancestors
    // again instead of serving the cached failure.
    first.unmount()
    renderPanel()
    await waitFor(() =>
      expect(mockGetGfsResourceByPath.mock.calls.length).toBeGreaterThan(callsAfterFirstOpen)
    )
  })

  it.each([403, 429, 500])(
    'keeps a known member and the existing notice after a later %s read failure',
    async status => {
      const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
      const text = JSON.stringify({ error: 'request_failed', message: 'parent read failed' })
      const error = actual.formatApiError(new Response(text, { status }), text)
      mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
        if (path === '/team-docs') return byPathView(FOLDER_ID, 'team-docs')
        throw error
      })
      renderPanel()
      const existing = await screen.findByRole('region', { name: 'People with access' })
      const member = await within(existing).findByTestId(miguelRowTestId)
      expect(within(member).getByText('Miguel')).toBeTruthy()
      await waitFor(() => expect(within(existing).queryByText('Loading access…')).toBeNull())
      expect(within(existing).getByRole('status').className).toContain(
        'cu-gfs-existing-access__notice'
      )
      expect(within(existing).getByRole('status').textContent).toMatch(
        /parent folders|parent folder/
      )
      expect(within(existing).queryByText('No one has access yet.')).toBeNull()
    }
  )

  // The read-boundary notice carries a plain-language hover explainer.
  it('titles the read-boundary notice with a plain-language explainer', async () => {
    const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
    const text = JSON.stringify({ error: 'request_failed', message: 'parent read failed' })
    const error = actual.formatApiError(new Response(text, { status: 403 }), text)
    mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
      if (path === '/team-docs') return byPathView(FOLDER_ID, 'team-docs')
      throw error
    })
    renderPanel()

    const existing = await screen.findByRole('region', { name: 'People with access' })
    const notice = await within(existing).findByText(
      'There may be access from parent folders you cannot see.'
    )
    expect(notice.closest('.cu-gfs-existing-access__notice')?.getAttribute('title')).toBe(
      'Some folders above this one are not visible to you. People may still have access through them, but we cannot show who.'
    )
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
    const rows = await within(existing).findAllByTestId(miguelRowTestId)
    expect(rows).toHaveLength(1)
    expect(
      within(rows[0]).getByRole('button', { name: 'Access role for Miguel' }).textContent
    ).toContain('Editor')

    // A confirmed downgrade routes only to the folders above the target.
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

  // R1-H1 — Drive-aligned multi-ancestor semantics. Reference scenario:
  // Marketing (Viewer) → Campaigns (Editor) → report.svg. The nested-file
  // path is '/marketing/campaigns/report.md'.
  describe('R1-H1 multi-ancestor edits', () => {
    const MKT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const CMP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const MKT_GRANT_ID = 'mkt-grant-1'
    const CMP_GRANT_ID = 'cmp-grant-1'
    const EDITOR = ['read', 'write', 'delete', 'manage_acl', 'share']
    const VIEWER = ['read', 'share']

    const nestedFile = {
      resourceId: FILE_ID,
      name: 'report.svg',
      gfsUri: 'gfs://main/report',
      kind: 'file',
      path: '/marketing/campaigns/report.svg',
    }

    /** marketing → campaigns → report.svg, with per-folder roles for Miguel. */
    function driveScenario(folders: {
      campaigns?: string[] | null
      marketing?: string[] | null
      rootShare?: string[] | null
      fileGrant?: string[] | null
    }) {
      mockGetGfsResourceByPath.mockImplementation(async (_drive, path) => {
        if (path === '/marketing/campaigns') return byPathView(CMP_ID, 'campaigns')
        if (path === '/marketing') return byPathView(MKT_ID, 'marketing')
        if (path === '/') return byPathView(ROOT_ID, '')
        throw Object.assign(new Error('404 not_found'), { status: 404 })
      })
      mockGetGfsGrants.mockImplementation(async resourceId => {
        if (resourceId === CMP_ID && folders.campaigns) {
          return {
            items: [
              {
                id: CMP_GRANT_ID,
                drive: 'main',
                resourceId: CMP_ID,
                subject: miguel,
                permissions: folders.campaigns,
                inherit: true,
              },
            ],
          }
        }
        if (resourceId === MKT_ID && folders.marketing) {
          return {
            items: [
              {
                id: MKT_GRANT_ID,
                drive: 'main',
                resourceId: MKT_ID,
                subject: miguel,
                permissions: folders.marketing,
                inherit: true,
              },
            ],
          }
        }
        if (resourceId === FILE_ID && folders.fileGrant) {
          return {
            items: [
              {
                id: FILE_GRANT_ID,
                drive: 'main',
                resourceId: FILE_ID,
                subject: miguel,
                permissions: folders.fileGrant,
                inherit: false,
              },
            ],
          }
        }
        return { items: [] }
      })
      mockGetGfsShares.mockImplementation(async resourceId => {
        if (resourceId === ROOT_ID && folders.rootShare) {
          return {
            items: [
              {
                id: ROOT_SHARE_ID,
                drive: 'main',
                resourceId: ROOT_ID,
                subject: miguel,
                permissions: folders.rootShare,
                includeDescendants: true,
              },
            ],
          }
        }
        return { items: [] }
      })
    }

    function grantError(status: number, code: string) {
      return Object.assign(new Error(`${status} ${code}`), { status, code, serverMessage: code })
    }

    async function openRoleDialog(resource = nestedFile) {
      renderPanel(resource)
      const existing = await screen.findByRole('region', { name: 'People with access' })
      const row = await within(existing).findByTestId(miguelRowTestId)
      return row
    }

    it('removes the member from EVERY contributing ancestor after confirmation', async () => {
      driveScenario({ campaigns: EDITOR, rootShare: VIEWER, fileGrant: VIEWER })
      const row = await openRoleDialog()

      fireEvent.click(within(row).getByRole('button', { name: 'Actions for Miguel' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }))

      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('Remove from parent folder?')).toBeTruthy()
      // Every affected folder is listed with its own current role…
      expect(within(dialog).getByText('campaigns')).toBeTruthy()
      expect(within(dialog).getByText('main')).toBeTruthy()
      expect(within(dialog).getByText('report.svg')).toBeTruthy()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

      // …and every ancestor row is revoked: both folders plus the file's
      // own direct grant.
      await waitFor(() => expect(mockDeleteGfsGrant).toHaveBeenCalledWith(CMP_GRANT_ID))
      await waitFor(() => expect(mockDeleteGfsShare).toHaveBeenCalledWith(ROOT_SHARE_ID))
      await waitFor(() => expect(mockDeleteGfsGrant).toHaveBeenCalledWith(FILE_GRANT_ID))
      await waitFor(() =>
        expect(screen.getByText('Access removed on 2 folders and everything inside them.'))
      )
    })

    it('downgrades only the ancestors above the target role (Drive: campaigns Editor→Read, marketing untouched)', async () => {
      driveScenario({ campaigns: EDITOR, marketing: VIEWER })
      const row = await openRoleDialog()

      await chooseRole(row, 'Read')
      const dialog = await screen.findByRole('alertdialog')
      // Only the editor folder is affected; marketing stays untouched.
      expect(within(dialog).getByText('campaigns')).toBeTruthy()
      expect(within(dialog).queryByText('marketing')).toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

      await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(1))
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: CMP_ID,
        subject: miguel,
        permissions: VIEWER,
        inherit: true,
      })
      await waitFor(() =>
        expect(screen.getByText('Miguel is now Read-only on campaigns and everything inside it.'))
      )
    })

    it('lowers EVERY editor ancestor when all sit above the target', async () => {
      driveScenario({ campaigns: EDITOR, marketing: EDITOR })
      const row = await openRoleDialog()

      await chooseRole(row, 'Read')
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('campaigns')).toBeTruthy()
      expect(within(dialog).getByText('marketing')).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

      await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(2))
      const touched = mockPutGfsGrant.mock.calls.map(call => call[0].resourceId)
      expect(touched).toEqual([CMP_ID, MKT_ID])
      await waitFor(() =>
        expect(
          screen.getByText(
            'Miguel is now Read-only on campaigns and marketing and everything inside them.'
          )
        )
      )
    })

    it('raises exactly ONE strongest ancestor on upgrade', async () => {
      driveScenario({ campaigns: VIEWER, marketing: VIEWER })
      const row = await openRoleDialog()

      await chooseRole(row, 'Editor')
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('campaigns')).toBeTruthy()
      expect(within(dialog).queryByText('marketing')).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

      await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(1))
      expect(mockPutGfsGrant).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: CMP_ID, permissions: EDITOR, inherit: true })
      )
    })

    // N1 — the dropdown shows the MERGED role (direct ⊔ inherited);
    // re-selecting the already-displayed role must be a no-op, not an
    // inherited-floor comparison that escalates the parent folder.
    it('re-selecting the displayed merged role opens no modal and issues no writes', async () => {
      // Direct Editor grant on the file + inherited Read floor on campaigns:
      // the row displays Editor even though the inherited-only role is Read.
      driveScenario({ campaigns: VIEWER, fileGrant: EDITOR })
      const row = await openRoleDialog()

      expect(
        within(row).getByRole('button', { name: 'Access role for Miguel' }).textContent
      ).toContain('Editor')

      await chooseRole(row, 'Editor')

      // No confirmation, no writes — the displayed role was re-selected.
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(mockPutGfsGrant).not.toHaveBeenCalled()
      expect(mockDeleteGfsGrant).not.toHaveBeenCalled()
      expect(mockDeleteGfsShare).not.toHaveBeenCalled()
    })

    it('updates only the direct grant when the inherited floor already has the target role', async () => {
      // Direct Editor grant on the file + inherited Read floor on campaigns:
      // lowering the merged role to Read must not open an empty parent-folder
      // confirmation; only the direct file grant needs alignment.
      driveScenario({ campaigns: VIEWER, fileGrant: EDITOR })
      const row = await openRoleDialog()

      await chooseRole(row, 'Read')

      expect(screen.queryByRole('alertdialog')).toBeNull()
      await waitFor(() => expect(mockPutGfsGrant).toHaveBeenCalledTimes(1))
      expect(mockPutGfsGrant).toHaveBeenCalledWith({
        drive: 'main',
        resourceId: FILE_ID,
        subject: miguel,
        permissions: VIEWER,
        inherit: false,
      })
    })

    it('states the true partial outcome when a folder update fails mid-run', async () => {
      driveScenario({ campaigns: EDITOR, marketing: EDITOR })
      mockPutGfsGrant.mockImplementation(async body => {
        if (body.resourceId === MKT_ID) throw grantError(403, 'escalation_rejected')
        return { ok: true, resourceId: body.resourceId, updated: [], count: 0 }
      })
      const row = await openRoleDialog()

      await chooseRole(row, 'Read')
      const dialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Update role' }))

      // The nearest folder was updated; marketing failed — the toast says
      // exactly how far the change got and never claims full success.
      await waitFor(() =>
        expect(screen.getByText('Updated 1 of 2 folders — marketing still grants access.'))
      )
      // The server verdict is surfaced and both lists reload so the dialog
      // shows the TRUE partial state.
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('escalation_rejected')
      await waitFor(() => expect(mockGetGfsGrants.mock.calls.length).toBeGreaterThan(2))
    })

    it('states the true partial outcome when a folder removal fails mid-run', async () => {
      driveScenario({ campaigns: EDITOR, marketing: EDITOR })
      mockDeleteGfsGrant.mockImplementation(async id => {
        if (id === MKT_GRANT_ID) throw grantError(403, 'escalation_rejected')
      })
      const row = await openRoleDialog()

      fireEvent.click(within(row).getByRole('button', { name: 'Actions for Miguel' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }))
      const dialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() =>
        expect(screen.getByText('Removed from 1 of 2 folders — marketing still grants access.'))
      )
      expect(mockDeleteGfsGrant).toHaveBeenCalledWith(CMP_GRANT_ID)
    })
  })
})
