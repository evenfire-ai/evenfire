// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsGrantList } from '../GfsGrantList'
import type { GfsGrantListItem, GfsShareListItem } from '../delegation.types'

/**
 * "Who has access" list (Manage modal). Rows resolve host subjects to agent
 * names, user/team subjects through the visible team directory, and fall back
 * to the raw id (a row is never hidden). A manage_acl_required list failure is
 * an expected state and renders as a quiet informational banner, not an error.
 */

afterEach(cleanup)

const agents = [{ id: '1st:mcp-host/chatllm', name: 'Chat LLM' }]
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
    expect(within(agentRow).getByText('X')).toBeTruthy()
    expect(
      within(agentRow).getByRole('button', { name: 'Revoke access for Chat LLM' }).className
    ).toContain('da-gfs-grant-list__revoke')

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

  it('fires the revoke callback from the row button with an accessible name', () => {
    const onRevoke = vi.fn()
    const item = grantItem({ id: 'grant-1' })
    render(<GfsGrantList agents={agents} items={[item]} onRevoke={onRevoke} subjects={subjects} />)

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Chat LLM' }))

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
    fireEvent.click(
      within(shareRow).getByRole('button', { name: 'Revoke shared access for Core Team' })
    )

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
    expect(screen.queryByRole('button', { name: /Revoke access for/ })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Chat LLM' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Revoke shared access for Core Team' }))
    expect(onRevokeShare).toHaveBeenCalledWith(share, 'Core Team')
  })
})
