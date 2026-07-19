// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsSubjectBatchError } from '@lib/gfsSubjectBatch'
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
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    // Only held bits are rendered as toggles — write/delete are NOT offered.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Read' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Manage access' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create share' })).toBeNull()

    fireEvent.focus(screen.getByRole('combobox', { name: 'Add people or teams' }))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

    await waitFor(() => expect(onGrant).toHaveBeenCalledWith(['user:u2'], ['read']))
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
    fireEvent.focus(screen.getByRole('combobox', { name: 'Add people or teams' }))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

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

    expect(screen.getByRole('combobox', { name: 'Add people or teams' })).toHaveProperty(
      'tagName',
      'INPUT'
    )
    expect(screen.getByRole('button', { name: 'Grant access' })).toHaveProperty('disabled', true)
    expect(screen.queryByPlaceholderText(/uuid/i)).toBeNull()
  })

  it('exposes user and team options together without privileged subject types', () => {
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

    fireEvent.focus(screen.getByRole('combobox', { name: 'Add people or teams' }))
    expect(screen.getByRole('option', { name: /Delegate User/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Core Team/ })).toBeTruthy()
    expect(screen.queryByText('Operator')).toBeNull()
    expect(screen.queryByText('Host')).toBeNull()
    expect(screen.queryByText('Context')).toBeNull()
  })

  it('retains only failed subjects when a batch partially succeeds', async () => {
    const onGrant = vi
      .fn()
      .mockRejectedValue(
        new GfsSubjectBatchError(
          'Grant access',
          ['user:successful'],
          [{ subjectKey: 'team:blocked', message: 'escalation_rejected' }]
        )
      )
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[
          { type: 'user', id: 'successful', label: 'Successful User' },
          { type: 'team', id: 'blocked', label: 'Blocked Team' },
        ]}
        onGrant={onGrant}
      />
    )

    const picker = screen.getByRole('combobox', { name: 'Add people or teams' })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Successful User/ }))
    fireEvent.click(screen.getByRole('option', { name: /Blocked Team/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

    await screen.findByText(/team:blocked \(escalation_rejected\)/)
    expect(screen.queryByRole('button', { name: 'Remove Successful User' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Blocked Team' })).toBeTruthy()
  })
})
