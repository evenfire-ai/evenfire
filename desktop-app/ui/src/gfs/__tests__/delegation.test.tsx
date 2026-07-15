// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsDelegationPanel } from '../delegation'

/**
 * P4-S07 — Desktop delegation panel (renderer). Affordance-driven: it only SHOWS
 * controls the caller can exercise. Covers the user-type journey at the UI layer
 * (plain reader vs folder owner) and proves no-escalation is reflected (only the
 * caller's own bits are offered) while enforcement stays server-side.
 */

afterEach(cleanup)

describe('GfsDelegationPanel', () => {
  it('a plain reader (canDelegate=false) sees no controls', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: false, grantableBits: [], canCreateShare: false }}
        subjectOptions={[]}
        onGrant={vi.fn()}
      />
    )
    expect(screen.getByRole('note').textContent).toMatch(/delegation rights/i)
    expect(screen.queryByRole('button', { name: 'Grant' })).toBeNull()
  })

  it('a folder owner offers ONLY the bits it holds (no escalation) and grants them', async () => {
    const onGrant = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsDelegationPanel
        affordances={{
          canDelegate: true,
          grantableBits: ['read', 'manage_acl'],
          canCreateShare: false,
        }}
        subjectOptions={[
          { type: 'user', id: 'u2', label: 'Delegate User', description: 'test2@clerum.io' },
        ]}
        onGrant={onGrant}
      />
    )
    // Only held bits are rendered as toggles — write/delete are NOT offered.
    expect(screen.getByRole('button', { name: 'read' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'manage_acl' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'write' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create share' })).toBeNull()

    fireEvent.click(screen.getByLabelText('subject'))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))

    await waitFor(() => expect(onGrant).toHaveBeenCalledWith('user:u2', ['read']))
  })

  it('shows Create share only when the caller holds the share bit', () => {
    const onCreateShare = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read', 'share'], canCreateShare: true }}
        subjectOptions={[{ type: 'team', id: 'team-1', label: 'Core Team', description: 'member' }]}
        onGrant={vi.fn()}
        onCreateShare={onCreateShare}
      />
    )
    expect(screen.getByRole('button', { name: 'Create share' })).toBeTruthy()
  })

  it('surfaces a server no-escalation rejection (fail-loud, not swallowed)', async () => {
    const onGrant = vi.fn().mockRejectedValue(new Error('escalation_rejected'))
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[
          { type: 'user', id: 'u2', label: 'Delegate User', description: 'test2@clerum.io' },
        ]}
        onGrant={onGrant}
      />
    )
    fireEvent.click(screen.getByLabelText('subject'))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }))

    const alert = await screen.findByText(/escalation_rejected/)
    expect(alert).toBeTruthy()
  })

  it('requires a visible directory subject instead of free-form UUID input', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[]}
        onGrant={vi.fn()}
      />
    )

    expect(screen.getByLabelText('subject')).toHaveProperty('tagName', 'BUTTON')
    expect(screen.getByRole('button', { name: 'Grant' })).toHaveProperty('disabled', true)
    expect(screen.queryByPlaceholderText(/uuid/i)).toBeNull()
  })

  it('exposes only user/team subject types from the Desktop user plane', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[
          { type: 'user', id: 'u2', label: 'Delegate User' },
          { type: 'team', id: 'team-1', label: 'Core Team' },
        ]}
        onGrant={vi.fn()}
      />
    )

    const subjectType = screen.getByLabelText('Subject type')
    fireEvent.click(subjectType)
    expect(screen.getByRole('option', { name: 'User' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Team' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Operator' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Host' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Context' })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: 'Team' }))
    fireEvent.click(screen.getByLabelText('subject'))
    expect(screen.getByRole('option', { name: 'Core Team' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Delegate User' })).toBeNull()
  })
})
