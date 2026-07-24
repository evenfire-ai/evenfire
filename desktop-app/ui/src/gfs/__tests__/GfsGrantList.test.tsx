// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsGrantList } from '../GfsGrantList'
import type { GfsGrantListItem } from '../delegation.types'

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

describe('GfsGrantList', () => {
  it('renders resolved subject labels, permission chips, and the inherit badge', () => {
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
        ]}
        onRevoke={vi.fn()}
        subjects={subjects}
      />
    )

    const agentRow = screen.getByText('Chat LLM').closest('li')!
    expect(within(agentRow).getByText('Read')).toBeTruthy()
    expect(within(agentRow).getByText('Write')).toBeTruthy()
    expect(within(agentRow).getByText('Includes contents')).toBeTruthy()

    const userRow = screen.getByText('Test Two').closest('li')!
    expect(within(userRow).getByText('Read')).toBeTruthy()
    expect(within(userRow).queryByText('Includes contents')).toBeNull()

    // Unresolvable subject ids stay visible as raw ids — never hidden.
    expect(screen.getByText('1st:mcp-host/unknown')).toBeTruthy()
  })

  it('fires the revoke callback from the row button with an accessible name', () => {
    const onRevoke = vi.fn()
    const item = grantItem({ id: 'grant-1' })
    render(<GfsGrantList agents={agents} items={[item]} onRevoke={onRevoke} subjects={subjects} />)

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Chat LLM' }))

    expect(onRevoke).toHaveBeenCalledWith(item, 'Chat LLM')
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

    expect(screen.getByText('No one has been granted access yet.')).toBeTruthy()
  })
})
