// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsGrantList } from '../GfsGrantList'
import type {
  GfsGrantListItem,
  GfsInheritedAccessItem,
  GfsShareListItem,
} from '../delegation.types'
import { mergeInheritedAccessItem } from '../inheritedAccessMerge'

/**
 * "Who has access" list (Manage modal). Rows resolve host subjects to agent
 * names, user/team subjects through the visible team directory. A user/team
 * outside the directory has no name this surface can act on, so its row is
 * filtered and one muted line explains what isn't listed and why; a fully
 * filtered list says so instead of claiming to be empty. Unresolved host ids
 * keep their raw identifier. A manage_acl_required list failure is an
 * expected state and renders as a quiet informational banner, not an error.
 */

afterEach(cleanup)

const HIDDEN_ACCESS_NOTICE_TEXT =
  'Members outside your teams aren’t listed here. Access can also follow from parent folders you cannot see.'

const agents = [{ id: '1st:mcp-host/chatllm', name: 'Chat LLM' }]
const userInheritedRowTestId = 'gfs-access-row-inherited-user:user-2'
const teamInheritedRowTestId = 'gfs-access-row-inherited-team:team-1'
const subjects = [
  { type: 'user' as const, id: 'user-2', label: 'Test Two', description: 'test2@clerum.io' },
  { type: 'team' as const, id: 'team-1', label: 'Core Team' },
]

function grantItem(overrides: Partial<GfsGrantListItem>): GfsGrantListItem {
  return {
    id: 'grant-1',
    drive: 'main',
    resourceId: 'res-1',
    subject: { type: 'host', id: '1st:mcp-host/chatllm' },
    permissions: ['read'],
    inherit: false,
    ...overrides,
  }
}

function shareItem(overrides: Partial<GfsShareListItem>): GfsShareListItem {
  return {
    id: 'share-1',
    drive: 'main',
    resourceId: 'res-1',
    subject: { type: 'team', id: 'team-1' },
    permissions: ['read'],
    includeDescendants: true,
    ...overrides,
  }
}

describe('GfsGrantList', () => {
  it('keeps context grants removable without offering a role control', () => {
    const onRevoke = vi.fn()
    const onChangeRole = vi.fn()
    const context = grantItem({
      id: 'context',
      subject: { type: 'context', id: 'context-a' },
      permissions: ['read', 'write'],
    })
    const user = grantItem({ id: 'user', subject: { type: 'user', id: 'user-2' } })
    render(
      <GfsGrantList
        agents={agents}
        items={[context, user]}
        onChangeRole={onChangeRole}
        onRevoke={onRevoke}
        subjects={subjects}
      />
    )

    const contextRow = screen.getByTestId('gfs-access-row-grant-context')
    expect(
      within(contextRow).queryByRole('button', { name: 'Access role for context-a' })
    ).toBeNull()
    expect(within(contextRow).getByText('Editor')).toBeTruthy()
    fireEvent.click(within(contextRow).getByRole('button', { name: 'Actions for context-a' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    expect(onRevoke).toHaveBeenCalledWith(context, 'context-a')

    const userRow = screen.getByTestId('gfs-access-row-grant-user')
    fireEvent.click(within(userRow).getByRole('button', { name: 'Access role for Test Two' }))
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    expect(onChangeRole).toHaveBeenCalledWith(user, 'Test Two', 'editor')
  })

  it('keeps context shares removable without offering a lowering control', () => {
    const onRevokeShare = vi.fn()
    const onLowerShare = vi.fn()
    const context = shareItem({
      id: 'context',
      subject: { type: 'context', id: 'context-a' },
      permissions: ['read', 'write'],
    })
    const user = shareItem({
      id: 'user',
      subject: { type: 'user', id: 'user-2' },
      permissions: ['read', 'write'],
    })
    render(
      <GfsGrantList
        agents={agents}
        items={[]}
        onLowerShare={onLowerShare}
        onRevoke={vi.fn()}
        onRevokeShare={onRevokeShare}
        shares={[context, user]}
        subjects={subjects}
      />
    )

    const contextRow = screen.getByTestId('gfs-access-row-share-context')
    expect(
      within(contextRow).queryByRole('button', { name: 'Access role for context-a' })
    ).toBeNull()
    expect(within(contextRow).getByText('Editor')).toBeTruthy()
    fireEvent.click(within(contextRow).getByRole('button', { name: 'Actions for context-a' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    expect(onRevokeShare).toHaveBeenCalledWith(context, 'context-a')

    const userRow = screen.getByTestId('gfs-access-row-share-user')
    fireEvent.click(within(userRow).getByRole('button', { name: 'Access role for Test Two' }))
    fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    expect(onLowerShare).toHaveBeenCalledWith(user, 'Test Two')
  })

  it('keeps inherited context access removable without offering a role control', () => {
    const onRemoveInherited = vi.fn()
    const onChangeInheritedRole = vi.fn()
    const folder = { resourceId: 'parent', name: 'Parent' }
    const inherited = (subject: { type: string; id: string }) =>
      mergeInheritedAccessItem(
        null,
        { subject, permissions: ['read', 'write'], grantId: subject.id, shareIds: [] },
        folder
      )
    render(
      <GfsGrantList
        agents={agents}
        inheritedItems={[
          inherited({ type: 'context', id: 'context-a' }),
          inherited({ type: 'user', id: 'user-2' }),
        ]}
        items={[]}
        mergeInherited
        onChangeInheritedRole={onChangeInheritedRole}
        onRemoveInherited={onRemoveInherited}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    const contextRow = screen.getByTestId('gfs-access-row-inherited-context:context-a')
    expect(
      within(contextRow).queryByRole('button', { name: 'Access role for context-a' })
    ).toBeNull()
    expect(within(contextRow).getByText('Editor')).toBeTruthy()
    fireEvent.click(within(contextRow).getByRole('button', { name: 'Actions for context-a' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    expect(onRemoveInherited).toHaveBeenCalledWith(
      expect.objectContaining({ subject: { type: 'context', id: 'context-a' } }),
      'context-a'
    )

    const userRow = screen.getByTestId(userInheritedRowTestId)
    fireEvent.click(within(userRow).getByRole('button', { name: 'Access role for Test Two' }))
    fireEvent.click(screen.getByRole('option', { name: 'Read' }))
    expect(onChangeInheritedRole).toHaveBeenCalledWith(
      expect.objectContaining({ subject: { type: 'user', id: 'user-2' } }),
      'Test Two',
      'read'
    )
  })

  it('keeps foreign agent grants removable without offering their role control', () => {
    const onRevoke = vi.fn()
    const onChangeRole = vi.fn()
    const foreign = grantItem({
      id: 'foreign',
      subject: { type: 'host', id: '1st:mcp-host/foreign' },
      permissions: ['read', 'write'],
    })
    render(
      <GfsGrantList
        agents={agents}
        items={[foreign, grantItem({ id: 'own' })]}
        onChangeRole={onChangeRole}
        onRevoke={onRevoke}
        subjects={subjects}
      />
    )

    const foreignRow = screen.getByTestId('gfs-access-row-grant-foreign')
    expect(within(foreignRow).getByText('Editor')).toBeTruthy()
    expect(
      within(foreignRow).queryByRole('button', {
        name: 'Access role for 1st:mcp-host/foreign',
      })
    ).toBeNull()
    fireEvent.click(
      within(foreignRow).getByRole('button', { name: 'Actions for 1st:mcp-host/foreign' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    expect(onRevoke).toHaveBeenCalledWith(foreign, '1st:mcp-host/foreign')

    const ownRow = screen.getByTestId('gfs-access-row-grant-own')
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Access role for Chat LLM' }))
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    expect(onChangeRole).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'own' }),
      'Chat LLM',
      'editor'
    )
  })

  it('renders resolved subject labels, grouped roles, and revoke controls', () => {
    render(
      <GfsGrantList
        agents={agents}
        items={[
          grantItem({ id: 'grant-1', permissions: ['read', 'write'], inherit: true }),
          grantItem({
            id: 'grant-2',
            subject: { type: 'user', id: 'user-2' },
            permissions: ['read'],
          }),
          grantItem({ id: 'grant-3', subject: { type: 'host', id: '1st:mcp-host/unknown' } }),
          grantItem({
            id: 'grant-4',
            subject: { type: 'host', id: '3rd:sandbox-recipes/monthly-report' },
          }),
        ]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    const agentRow = screen.getByText('Chat LLM').closest('li')!
    expect(agentRow.querySelector('[data-subject-kind="agent"] svg')).not.toBeNull()
    expect(within(agentRow).queryByText(/direct grant|\bhost\b/i)).toBeNull()
    expect(
      within(agentRow).getByRole('button', { name: 'Access role for Chat LLM' }).textContent
    ).toContain('Editor')
    expect(within(agentRow).queryByText('Includes contents')).toBeNull()
    expect(within(agentRow).queryByText('X')).toBeNull()
    const actions = within(agentRow).getByRole('button', { name: 'Actions for Chat LLM' })
    expect(actions.className).toContain('da-gfs-resource-menu__trigger')
    expect(actions.querySelectorAll('circle')).toHaveLength(3)

    const userRow = screen.getByText('Test Two').closest('li')!
    expect(userRow.querySelector('[data-subject-kind="user"] svg')).not.toBeNull()
    expect(within(userRow).queryByText(/direct grant|\buser\b/i)).toBeNull()
    expect(
      within(userRow).getByRole('button', { name: 'Access role for Test Two' }).textContent
    ).toContain('Read')
    expect(within(userRow).queryByText('Includes contents')).toBeNull()

    // Unresolvable subject ids stay visible as raw ids — never hidden.
    expect(screen.getByText('1st:mcp-host/unknown')).toBeTruthy()
    const workflowRow = screen.getByText('monthly-report').closest('li')!
    expect(workflowRow.querySelector('[data-subject-kind="workflow"] svg')).not.toBeNull()
  })

  it('filters directory-less user and team rows and explains what is not listed', () => {
    render(
      <GfsGrantList
        agents={agents}
        items={[
          grantItem({
            id: 'grant-hidden-user',
            subject: { type: 'user', id: 'user-outside-directory' },
            permissions: ['read', 'share'],
          }),
          grantItem({
            id: 'grant-hidden-team',
            subject: { type: 'team', id: 'team-outside-directory' },
            permissions: ['read'],
          }),
          grantItem({
            id: 'grant-resolved',
            subject: { type: 'user', id: 'user-2' },
            permissions: ['read'],
          }),
        ]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    // Directory-less members never render — not as rows, not as raw ids.
    expect(screen.queryByText('Hidden user')).toBeNull()
    expect(screen.queryByText('Hidden team')).toBeNull()
    expect(screen.queryByText('user-outside-directory')).toBeNull()
    expect(screen.queryByText('team-outside-directory')).toBeNull()
    expect(screen.queryByTestId('gfs-access-row-grant-grant-hidden-user')).toBeNull()
    expect(screen.queryByTestId('gfs-access-row-grant-grant-hidden-team')).toBeNull()
    // Resolved members stay, with no tooltip machinery.
    expect(screen.getByText('Test Two')).toBeTruthy()
    expect(screen.getByText('Test Two').getAttribute('title')).toBeNull()
    // The muted line explains the filtering once.
    expect(screen.getAllByText(HIDDEN_ACCESS_NOTICE_TEXT)).toHaveLength(1)
  })

  it('protects another home owner grant while a manager grant retains its actions', () => {
    render(
      <GfsGrantList
        agents={agents}
        subjects={[...subjects, { type: 'user', id: 'owner', label: 'Home Owner' }]}
        items={[
          grantItem({
            id: 'owner',
            resourceId: 'home',
            subject: { type: 'user', id: 'owner' },
            homeOwner: true,
            inherit: true,
          }),
          grantItem({ id: 'other', resourceId: 'home', subject: { type: 'user', id: 'user-2' } }),
        ]}
        onChangeRole={vi.fn()}
        onRevoke={vi.fn()}
      />
    )
    const owner = screen.getByTestId('gfs-access-row-grant-owner')
    expect(within(owner).queryByRole('button', { name: 'Access role for Home Owner' })).toBeNull()
    expect(within(owner).queryByRole('button', { name: 'Actions for Home Owner' })).toBeNull()
    expect(within(owner).getByText('Owner')).toBeTruthy()
    // A viewer whose directory names the owner keeps seeing that name.
    expect(within(owner).getByText('Home Owner')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Actions for Test Two' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Access role for Test Two' })).toBeTruthy()
  })

  it.each(['direct', 'inherited', 'merged-direct'] as const)(
    'hides a %s home owner row from a viewer outside the owner’s teams',
    source => {
      const owner = { type: 'user' as const, id: 'private-owner-id' }
      const other = { type: 'user' as const, id: 'private-other-id' }
      const inherited = (subject: typeof owner, homeOwner = false) => ({
        ...mergeInheritedAccessItem(
          null,
          { subject, permissions: ['read'], grantId: 'ancestor-grant', shareIds: [] },
          { resourceId: 'home', name: 'Home' }
        ),
        ...(homeOwner ? { homeOwner: true as const } : {}),
      })
      render(
        <GfsGrantList
          agents={[]}
          // The viewer has a home, but it is a different one: the owner row on
          // `home` is not the caller's own grant.
          isOwnHomeRoot={id => id === 'viewer-home'}
          subjects={subjects}
          items={[
            ...(source !== 'inherited'
              ? [grantItem({ id: 'owner', resourceId: 'home', subject: owner, homeOwner: true })]
              : []),
            grantItem({ id: 'other', subject: other }),
            grantItem({ id: 'teammate', subject: { type: 'user', id: 'user-2' } }),
          ]}
          inheritedItems={
            source === 'direct' ? [] : [inherited(owner, source === 'inherited'), inherited(other)]
          }
          mergeInherited={source !== 'direct'}
          onChangeRole={vi.fn()}
          onChangeInheritedRole={vi.fn()}
          onRemoveInherited={vi.fn()}
          onRevoke={vi.fn()}
        />
      )

      // U1: an out-of-team viewer never gets the owner row — not as a row and
      // not as an anonymous "Owner" label.
      expect(
        screen.queryByTestId(
          source === 'direct'
            ? 'gfs-access-row-grant-owner'
            : 'gfs-access-row-inherited-user:private-owner-id'
        )
      ).toBeNull()
      expect(screen.queryByText('Owner')).toBeNull()
      expect(screen.queryByText('private-owner-id')).toBeNull()
      expect(screen.getByText(HIDDEN_ACCESS_NOTICE_TEXT)).toBeTruthy()
      // Witness: the in-directory member keeps its row and actions in the same
      // list, so the absence above is not an empty render.
      const teammate = screen.getByText('Test Two').closest('li')!
      expect(within(teammate).getByRole('button', { name: 'Actions for Test Two' })).toBeTruthy()
      expect(screen.queryByTestId('gfs-access-row-grant-other')).toBeNull()
      expect(screen.queryByTestId('gfs-access-row-inherited-user:private-other-id')).toBeNull()
    }
  )

  it.each(['direct', 'inherited'] as const)(
    'shows the home owner their own Owner row without a team, and no hidden-members notice',
    source => {
      const owner = { type: 'user' as const, id: 'private-owner-id' }
      const ownerPermissions = ['read', 'write', 'delete', 'share', 'manage_acl']
      const inheritedOwner = {
        ...mergeInheritedAccessItem(
          null,
          {
            subject: owner,
            permissions: ownerPermissions,
            grantId: 'owner-grant',
            shareIds: [],
          },
          { resourceId: 'home', name: 'Home' }
        ),
        homeOwner: true as const,
      }
      render(
        <GfsGrantList
          agents={[]}
          isOwnHomeRoot={id => id === 'home'}
          subjects={[]}
          items={
            source === 'direct'
              ? [
                  grantItem({
                    id: 'owner',
                    resourceId: 'home',
                    subject: owner,
                    homeOwner: true,
                    permissions: ownerPermissions,
                    inherit: true,
                  }),
                ]
              : []
          }
          inheritedItems={source === 'inherited' ? [inheritedOwner] : []}
          mergeInherited={source === 'inherited'}
          onChangeRole={vi.fn()}
          onChangeInheritedRole={vi.fn()}
          onRemoveInherited={vi.fn()}
          onRevoke={vi.fn()}
        />
      )

      // Witness: the owner's own row is listed even though the directory is empty.
      const row = screen.getByTestId(
        source === 'direct'
          ? 'gfs-access-row-grant-owner'
          : 'gfs-access-row-inherited-user:private-owner-id'
      )
      // The identity span stays hidden (no name in the directory), so the row
      // reads "Owner" and never the owner's UUID.
      expect(row.textContent).toBe('Owner')
      expect(within(row).queryByRole('button')).toBeNull()
      expect(screen.queryByText(HIDDEN_ACCESS_NOTICE_TEXT)).toBeNull()
      expect(screen.queryByText('Only members outside your teams have access here.')).toBeNull()
    }
  )

  it.each(['inherited', 'direct'] as const)(
    'protects an owner grant from a %s contribution in a merged row',
    ownerSource => {
      const subject = { type: 'user', id: 'owner' }
      const inherited = {
        ...mergeInheritedAccessItem(
          null,
          {
            subject,
            permissions: ['read', 'write', 'delete', 'share', 'manage_acl'],
            grantId: 'owner-grant',
            shareIds: [],
          },
          { resourceId: 'home', name: 'Home' }
        ),
        ...(ownerSource === 'inherited' ? { homeOwner: true as const } : {}),
      }
      render(
        <GfsGrantList
          agents={agents}
          subjects={[...subjects, { type: 'user', id: 'owner', label: 'Home Owner' }]}
          items={[
            grantItem({ id: 'other', subject: { type: 'user', id: 'user-2' } }),
            ...(ownerSource === 'direct'
              ? [grantItem({ id: 'owner', subject, homeOwner: true })]
              : []),
          ]}
          inheritedItems={[inherited]}
          mergeInherited
          onChangeInheritedRole={vi.fn()}
          onRemoveInherited={vi.fn()}
          onChangeRole={vi.fn()}
          onRevoke={vi.fn()}
        />
      )
      const row = screen.getByTestId('gfs-access-row-inherited-user:owner')
      expect(within(row).queryByRole('button', { name: 'Access role for Home Owner' })).toBeNull()
      expect(within(row).queryByRole('button', { name: 'Actions for Home Owner' })).toBeNull()
      expect(within(row).getByText('Owner')).toBeTruthy()
      expect(within(row).getByText('Home Owner')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Actions for Test Two' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Access role for Test Two' })).toBeTruthy()
    }
  )

  it('never claims an empty folder when the filter removed every row', () => {
    render(
      <GfsGrantList
        agents={agents}
        items={[
          grantItem({
            id: 'grant-hidden-user',
            subject: { type: 'user', id: 'user-outside-directory' },
            permissions: ['read'],
          }),
        ]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    expect(screen.queryByText('No one has access yet.')).toBeNull()
    expect(screen.getByText('Only members outside your teams have access here.')).toBeTruthy()
    expect(screen.getAllByText(HIDDEN_ACCESS_NOTICE_TEXT)).toHaveLength(1)
  })

  it('shows no hidden-members notice when every subject resolves', () => {
    render(
      <GfsGrantList
        agents={agents}
        items={[
          grantItem({
            id: 'grant-resolved',
            subject: { type: 'user', id: 'user-2' },
            permissions: ['read'],
          }),
        ]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    expect(screen.queryByText(HIDDEN_ACCESS_NOTICE_TEXT)).toBeNull()
    expect(screen.getByText('Test Two')).toBeTruthy()
  })

  it('labels a host subject by its displayName, falling back to the identifier when blank', () => {
    render(
      <GfsGrantList
        agents={[
          { id: '1st:mcp-host/withdisplay', name: 'withdisplay', displayName: 'Support Bot' },
          { id: '1st:mcp-host/blankdisplay', name: 'blankdisplay', displayName: '   ' },
        ]}
        items={[
          grantItem({ id: 'g-1', subject: { type: 'host', id: '1st:mcp-host/withdisplay' } }),
          grantItem({ id: 'g-2', subject: { type: 'host', id: '1st:mcp-host/blankdisplay' } }),
        ]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    // Present displayName wins over the identifier.
    expect(screen.getByText('Support Bot')).toBeTruthy()
    // A whitespace-only displayName must NOT render a blank label — fall back to the id-based name.
    expect(screen.getByText('blankdisplay')).toBeTruthy()
  })

  it('fires the revoke callback from the three-dot menu', () => {
    const onRevoke = vi.fn()
    const item = grantItem({ id: 'grant-1' })
    render(<GfsGrantList agents={agents} items={[item]} onRevoke={onRevoke} subjects={subjects} />)

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Chat LLM' }))
    const menu = screen.getByRole('menu', { name: 'Actions for Chat LLM' })
    expect(menu.parentElement).toBe(document.body)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove access' }))

    expect(onRevoke).toHaveBeenCalledWith(item, 'Chat LLM')
  })

  it('changes a member between the grouped Read and Editor roles', () => {
    const onChangeRole = vi.fn()
    const item = grantItem({ subject: { type: 'user', id: 'user-2' } })
    render(
      <GfsGrantList
        agents={agents}
        items={[item]}
        onChangeRole={onChangeRole}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Access role for Test Two' }))
    expect(screen.getByRole('listbox').parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    expect(onChangeRole).toHaveBeenCalledWith(item, 'Test Two', 'editor')
  })

  it('combines direct shares with grants and routes share revoke separately', () => {
    const onRevoke = vi.fn()
    const onRevokeShare = vi.fn()
    const share = shareItem({})
    render(
      <GfsGrantList
        agents={agents}
        items={[grantItem({})]}
        onRevoke={onRevoke}
        onRevokeShare={onRevokeShare}
        shares={[share]}
        subjects={subjects}
      />
    )

    const shareRow = screen.getByTestId('gfs-access-row-share-share-1')
    expect(shareRow.querySelector('[data-subject-kind="team"] svg')).not.toBeNull()
    expect(within(shareRow).queryByText('Share · team')).toBeNull()
    expect(within(shareRow).queryByText('Includes contents')).toBeNull()
    fireEvent.click(within(shareRow).getByRole('button', { name: 'Actions for Core Team' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))

    expect(onRevokeShare).toHaveBeenCalledWith(share, 'Core Team')
    expect(onRevoke).not.toHaveBeenCalled()
  })

  it('renders manage_acl_required as a quiet informational banner instead of the list', () => {
    render(
      <GfsGrantList
        agents={agents}
        error={{
          code: 'manage_acl_required',
          message: 'Only people with manage access can view who has access here.',
          severity: 'quiet',
        }}
        items={[grantItem({ id: 'grant-1' })]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    const banner = screen.getByText('Only people with manage access can view who has access here.')
    expect(banner.closest('.status-banner')?.className).toContain('tone-info')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull()
  })

  it('renders other list failures as an error banner', () => {
    render(
      <GfsGrantList
        agents={agents}
        error={{ code: null, message: 'listGrants exploded', severity: 'error' }}
        items={[]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    const banner = screen.getByText('listGrants exploded')
    expect(banner.closest('.status-banner')?.className).toContain('tone-error')
  })

  it('renders an empty notice when nothing has been granted', () => {
    render(<GfsGrantList agents={agents} items={[]} onRevoke={vi.fn()} subjects={subjects} />)

    expect(screen.getByText('No one has access yet.')).toBeTruthy()
  })

  describe('inherited rows (file dialogs)', () => {
    const inheritedItem = (overrides: Partial<GfsInheritedAccessItem>): GfsInheritedAccessItem => ({
      subject: { type: 'user', id: 'user-2' },
      permissions: ['read', 'write'],
      inheritedFrom: ['team-docs'],
      sources: mergeInheritedAccessItem(
        null,
        {
          subject: { type: 'user', id: 'user-2' },
          permissions: ['read', 'write'],
          grantId: 'parent-grant-1',
          shareIds: [],
        },
        { resourceId: 'folder-1', name: 'team-docs' }
      ).sources,
      ...overrides,
    })

    it('keeps foreign inherited agents removable while own inherited agents remain editable', () => {
      const onChangeInheritedRole = vi.fn()
      const onRemoveInherited = vi.fn()
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[
            inheritedItem({ subject: { type: 'host', id: '1st:mcp-host/foreign' } }),
            inheritedItem({ subject: { type: 'host', id: '1st:mcp-host/chatllm' } }),
          ]}
          items={[]}
          mergeInherited
          onChangeInheritedRole={onChangeInheritedRole}
          onRemoveInherited={onRemoveInherited}
          onRevoke={vi.fn()}
          subjects={subjects}
        />
      )

      const foreignRow = screen.getByTestId('gfs-access-row-inherited-host:1st:mcp-host/foreign')
      expect(within(foreignRow).getByText('Editor')).toBeTruthy()
      expect(
        within(foreignRow).queryByRole('button', {
          name: 'Access role for 1st:mcp-host/foreign',
        })
      ).toBeNull()
      fireEvent.click(
        within(foreignRow).getByRole('button', { name: 'Actions for 1st:mcp-host/foreign' })
      )
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
      expect(onRemoveInherited).toHaveBeenCalledWith(
        expect.objectContaining({ subject: { type: 'host', id: '1st:mcp-host/foreign' } }),
        '1st:mcp-host/foreign'
      )

      const ownRow = screen.getByTestId('gfs-access-row-inherited-host:1st:mcp-host/chatllm')
      fireEvent.click(within(ownRow).getByRole('button', { name: 'Access role for Chat LLM' }))
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
      expect(onChangeInheritedRole).toHaveBeenCalledWith(
        expect.objectContaining({ subject: { type: 'host', id: '1st:mcp-host/chatllm' } }),
        'Chat LLM',
        'read'
      )
    })

    it('renders inherited members as normal toggleable rows with their strongest role', () => {
      const onChangeInheritedRole = vi.fn()
      const onRemoveInherited = vi.fn()
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[
            inheritedItem({}),
            inheritedItem({ subject: { type: 'team', id: 'team-1' }, permissions: ['read'] }),
          ]}
          items={[]}
          mergeInherited
          onChangeInheritedRole={onChangeInheritedRole}
          onRemoveInherited={onRemoveInherited}
          onRevoke={vi.fn()}
          subjects={subjects}
        />
      )

      const userRow = screen.getByTestId(userInheritedRowTestId)
      expect(within(userRow).getByText('Test Two')).toBeTruthy()
      expect(
        within(userRow).getByRole('button', { name: 'Access role for Test Two' }).textContent
      ).toContain('Editor')
      expect(within(userRow).getByRole('button', { name: 'Actions for Test Two' })).toBeTruthy()
      // Normal-looking row: no inherited label, no muted duplicate.
      expect(within(userRow).queryByText(/Inherited from/)).toBeNull()
      expect(userRow.className).not.toContain('inherited')
      expect(userRow.getAttribute('data-inherited')).toBe('true')
      expect(userRow.querySelector('[data-subject-kind="user"] svg')).not.toBeNull()

      const teamRow = screen.getByTestId(teamInheritedRowTestId)
      expect(
        within(teamRow).getByRole('button', { name: 'Access role for Core Team' }).textContent
      ).toContain('Read')
    })

    it('dedupes a member with both a direct grant and inherited access into one row', () => {
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[inheritedItem({ permissions: ['read', 'write'] })]}
          items={[grantItem({ subject: { type: 'user', id: 'user-2' }, permissions: ['read'] })]}
          mergeInherited
          onChangeInheritedRole={vi.fn()}
          onRemoveInherited={vi.fn()}
          onRevoke={vi.fn()}
          subjects={subjects}
        />
      )

      // One row per member: the direct grant row is consumed by the merge.
      expect(screen.queryByTestId('gfs-access-row-grant-grant-1')).toBeNull()
      const mergedRow = screen.getByTestId(userInheritedRowTestId)
      // Effective role is the strongest across direct and inherited sources.
      expect(
        within(mergedRow).getByRole('button', { name: 'Access role for Test Two' }).textContent
      ).toContain('Editor')
    })

    it('uses the stable subject identity when two inherited subjects share a type', () => {
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[
            inheritedItem({}),
            inheritedItem({ subject: { type: 'user', id: 'user-3' } }),
          ]}
          items={[]}
          mergeInherited
          onChangeInheritedRole={vi.fn()}
          onRemoveInherited={vi.fn()}
          onRevoke={vi.fn()}
          subjects={[
            ...subjects,
            { type: 'user' as const, id: 'user-3', label: 'Test Three', description: 't3' },
          ]}
        />
      )

      expect(screen.getByTestId('gfs-access-row-inherited-user:user-2')).toBeTruthy()
      expect(screen.getByTestId('gfs-access-row-inherited-user:user-3')).toBeTruthy()
    })

    it('fires the inherited change and remove callbacks for merged rows', () => {
      const onChangeInheritedRole = vi.fn()
      const onRemoveInherited = vi.fn()
      const item = inheritedItem({})
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[item]}
          items={[]}
          mergeInherited
          onChangeInheritedRole={onChangeInheritedRole}
          onRemoveInherited={onRemoveInherited}
          onRevoke={vi.fn()}
          subjects={subjects}
        />
      )

      const row = screen.getByTestId(userInheritedRowTestId)
      fireEvent.click(within(row).getByRole('button', { name: 'Access role for Test Two' }))
      fireEvent.click(screen.getByRole('option', { name: 'Read' }))
      expect(onChangeInheritedRole).toHaveBeenCalledTimes(1)
      const [changedRow, label, role] = onChangeInheritedRole.mock.calls[0]!
      expect(changedRow.inherited).toBe(item)
      expect(changedRow.permissions).toEqual(['read', 'write'])
      expect(label).toBe('Test Two')
      expect(role).toBe('read')

      fireEvent.click(within(row).getByRole('button', { name: 'Actions for Test Two' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
      expect(onRemoveInherited).toHaveBeenCalledWith(
        expect.objectContaining({ inherited: item }),
        'Test Two'
      )
    })

    it('consumes direct share rows of a merged member', () => {
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[
            inheritedItem({
              subject: { type: 'team', id: 'team-1' },
              permissions: ['read'],
            }),
          ]}
          items={[]}
          mergeInherited
          onChangeInheritedRole={vi.fn()}
          onRemoveInherited={vi.fn()}
          onRevoke={vi.fn()}
          onRevokeShare={vi.fn()}
          shares={[shareItem({})]}
          subjects={subjects}
        />
      )

      expect(screen.queryByTestId('gfs-access-row-share-share-1')).toBeNull()
      expect(screen.getByTestId(teamInheritedRowTestId)).toBeTruthy()
    })

    it('ignores inherited items without mergeInherited (folder dialogs unchanged)', () => {
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[inheritedItem({})]}
          items={[]}
          onRevoke={vi.fn()}
          subjects={subjects}
        />
      )

      expect(screen.queryByTestId(userInheritedRowTestId)).toBeNull()
      expect(screen.getByText('No one has access yet.')).toBeTruthy()
    })

    // R1-M3 — a total derivation failure is a quiet notice, never a silent
    // "no one has access".
    it('renders the derivation notice and suppresses the empty claim', () => {
      render(
        <GfsGrantList
          agents={agents}
          derivationNotice="Inherited access could not be loaded. Members with access from a parent folder may be missing."
          items={[]}
          onRevoke={vi.fn()}
          subjects={subjects}
        />
      )

      const banner = screen.getByText(/Inherited access could not be loaded/)
      expect(banner.closest('.status-banner')?.className).toContain('tone-info')
      expect(screen.queryByText('No one has access yet.')).toBeNull()
    })

    it('keeps direct-only rows editable alongside merged rows and never the empty notice', () => {
      const onRevoke = vi.fn()
      const grant = grantItem({ id: 'grant-1' })
      render(
        <GfsGrantList
          agents={agents}
          inheritedItems={[
            inheritedItem({ subject: { type: 'team', id: 'team-1' }, permissions: ['read'] }),
          ]}
          items={[grant]}
          mergeInherited
          onChangeRole={vi.fn()}
          onRevoke={onRevoke}
          subjects={subjects}
        />
      )

      expect(screen.queryByText('No one has access yet.')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Access role for Chat LLM' }))
      fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
      fireEvent.click(screen.getByRole('button', { name: 'Actions for Chat LLM' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
      expect(onRevoke).toHaveBeenCalled()
    })
  })

  // R4 spec §2 — grants and shares fail independently: a share-list error
  // must not hide successful grant rows or their revoke actions, and vice
  // versa. Regression for the early-return that swallowed grants whenever
  // listShares failed.
  it('keeps grants visible and revocable when only the share list fails', () => {
    const onRevoke = vi.fn()
    const grant = grantItem({ id: 'grant-1' })
    render(
      <GfsGrantList
        agents={agents}
        error={null}
        items={[grant]}
        onRevoke={onRevoke}
        shareError={{ code: null, message: 'listShares exploded', severity: 'error' }}
        shares={[]}
        subjects={subjects}
      />
    )

    // The share failure is visible…
    const banner = screen.getByText('listShares exploded')
    expect(banner.closest('.status-banner')?.className).toContain('tone-error')
    // …but the grant row and its revoke action stay available and work.
    const grantRow = screen.getByTestId('gfs-access-row-grant-grant-1')
    expect(within(grantRow).getByText('Chat LLM')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Chat LLM' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    expect(onRevoke).toHaveBeenCalledWith(grant, 'Chat LLM')
  })

  it('keeps shares visible and revocable when only the grants list fails', () => {
    const onRevokeShare = vi.fn()
    const share = shareItem({})
    render(
      <GfsGrantList
        agents={agents}
        error={{ code: null, message: 'listGrants exploded', severity: 'error' }}
        items={[]}
        onRevoke={vi.fn()}
        onRevokeShare={onRevokeShare}
        shares={[share]}
        subjects={subjects}
      />
    )

    expect(screen.getByText('listGrants exploded')).toBeTruthy()
    const shareRow = screen.getByTestId('gfs-access-row-share-share-1')
    expect(within(shareRow).getByText('Core Team')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Core Team' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
    expect(onRevokeShare).toHaveBeenCalledWith(share, 'Core Team')
  })
})
