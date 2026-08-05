// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsDelegationPanel } from '../delegation'

/**
 * P4-S07 — Desktop delegation panel (renderer). Affordance-driven: it only SHOWS
 * controls the caller can exercise. Covers the user-type journey at the UI layer
 * (plain reader vs folder owner) and proves no-escalation is reflected (only the
 * caller's own bits are offered) while enforcement stays server-side. People,
 * teams, and the caller's own agents share a single picker; a host in the
 * selection caps the whole bulk grant to read/write.
 */

const PICKER_LABEL = 'Add people, teams, or agents'

afterEach(cleanup)

describe('GfsDelegationPanel', () => {
  it('a plain reader (canDelegate=false) sees no controls', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: false, grantableBits: [], canCreateShare: false }}
        subjectOptions={[]}
        isDirectory={false}
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
        isDirectory={false}
        onGrant={onGrant}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    // Only held bits are rendered as toggles — write/delete are NOT offered.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Read' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Manage access' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create share' })).toBeNull()

    fireEvent.focus(screen.getByRole('combobox', { name: PICKER_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

    // Files never send inherit.
    await waitFor(() => expect(onGrant).toHaveBeenCalledWith(['user:u2'], ['read'], false))
  })

  it('shows Create share only when the caller holds the share bit', () => {
    const onCreateShare = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read', 'share'], canCreateShare: true }}
        subjectOptions={[{ type: 'team', id: 'team-1', label: 'Core Team', description: 'member' }]}
        isDirectory={false}
        onGrant={vi.fn()}
        onCreateShare={onCreateShare}
      />
    )
    expect(screen.getByRole('button', { name: 'Create share' })).toBeTruthy()
  })

  it('surfaces a server no-escalation rejection mapped to its human message (fail-loud)', async () => {
    const onGrant = vi.fn().mockRejectedValue(new Error('403 Forbidden: escalation_rejected'))
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[
          { type: 'user', id: 'u2', label: 'Delegate User', description: 'test2@clerum.io' },
        ]}
        isDirectory={false}
        onGrant={onGrant}
      />
    )
    fireEvent.focus(screen.getByRole('combobox', { name: PICKER_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

    // The panel maps the server code via describeGfsGrantError — never the raw code.
    const alert = await screen.findByText('You can only grant permissions you already hold here.')
    expect(alert).toBeTruthy()
  })

  it('requires a visible directory subject instead of free-form UUID input', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[]}
        isDirectory={false}
        onGrant={vi.fn()}
      />
    )

    expect(screen.getByRole('combobox', { name: PICKER_LABEL })).toHaveProperty('tagName', 'INPUT')
    expect(screen.getByRole('button', { name: 'Grant access' })).toHaveProperty('disabled', true)
    expect(screen.queryByPlaceholderText(/uuid/i)).toBeNull()
  })

  it('exposes user, team, and agent options together without privileged subject types', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[
          { type: 'user', id: 'u2', label: 'Delegate User' },
          { type: 'team', id: 'team-1', label: 'Core Team' },
          { type: 'host', id: '1st:mcp-host/chatllm', label: 'chatllm', badge: 'Agent' },
        ]}
        isDirectory={false}
        onGrant={vi.fn()}
      />
    )

    fireEvent.focus(screen.getByRole('combobox', { name: PICKER_LABEL }))
    expect(screen.getByRole('option', { name: /Delegate User/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Core Team/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /chatllm/ })).toBeTruthy()
    expect(screen.queryByText('Operator')).toBeNull()
    expect(screen.queryByText('Context')).toBeNull()
  })

  it('keeps the whole selection when the atomic bulk grant is rejected', async () => {
    // The bulk grant is all-or-nothing: a rejection means NOTHING landed, so
    // every selected subject stays selected for a retry (no partial-success).
    const onGrant = vi.fn().mockRejectedValue(new Error('400 Bad Request: subjects_invalid'))
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[
          { type: 'user', id: 'successful', label: 'Successful User' },
          { type: 'team', id: 'blocked', label: 'Blocked Team' },
        ]}
        isDirectory={false}
        onGrant={onGrant}
      />
    )

    const picker = screen.getByRole('combobox', { name: PICKER_LABEL })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Successful User/ }))
    fireEvent.click(screen.getByRole('option', { name: /Blocked Team/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))

    await screen.findByText('Some selected subjects are invalid and were rejected.')
    expect(onGrant).toHaveBeenCalledTimes(1)
    expect(onGrant).toHaveBeenCalledWith(
      ['user:successful', 'team:blocked'],
      ['read'],
      false
    )
    expect(screen.getByRole('button', { name: 'Remove Successful User' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Blocked Team' })).toBeTruthy()
  })

  it('caps the whole grant to read/write when an agent is selected and strips incompatible bits', async () => {
    const onGrant = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsDelegationPanel
        affordances={{
          canDelegate: true,
          grantableBits: ['read', 'write', 'manage_acl'],
          canCreateShare: true,
        }}
        subjectOptions={[
          { type: 'host', id: '1st:mcp-host/chatllm', label: 'chatllm', badge: 'Agent' },
        ]}
        isDirectory={false}
        onGrant={onGrant}
        onCreateShare={vi.fn().mockResolvedValue(undefined)}
      />
    )

    // Hold a bit a host cannot receive, then add the host.
    fireEvent.click(screen.getByRole('button', { name: 'Read' })) // open the dropdown
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Manage access' }))

    fireEvent.focus(screen.getByRole('combobox', { name: PICKER_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: /chatllm/ }))

    // Hint explains the cap; manage_acl has been stripped (the trigger summary
    // is back to a single bit, not "2 permissions") and hosts can't be shared to.
    expect(screen.getByText(/limited to read and write/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /2 permissions/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await waitFor(() =>
      expect(onGrant).toHaveBeenCalledWith(['host:1st:mcp-host/chatllm'], ['read'], false)
    )
  })

  it('offers an Include contents toggle for directories (default ON) and honors it', async () => {
    const onGrant = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[{ type: 'user', id: 'u2', label: 'Delegate User' }]}
        isDirectory
        onGrant={onGrant}
      />
    )

    const toggle = screen.getByRole('checkbox', { name: 'Include contents of this folder' })
    expect(toggle).toHaveProperty('checked', true)

    const picker = screen.getByRole('combobox', { name: PICKER_LABEL })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await waitFor(() => expect(onGrant).toHaveBeenCalledWith(['user:u2'], ['read'], true))

    // The panel clears the selection after a successful grant, so re-pick before
    // proving the unchecked toggle sends inherit=false.
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(toggle)
    expect(toggle).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await waitFor(() => expect(onGrant).toHaveBeenNthCalledWith(2, ['user:u2'], ['read'], false))
  })

  it('never shows the Include contents toggle for files', () => {
    render(
      <GfsDelegationPanel
        affordances={{ canDelegate: true, grantableBits: ['read'], canCreateShare: false }}
        subjectOptions={[{ type: 'user', id: 'u2', label: 'Delegate User' }]}
        isDirectory={false}
        onGrant={vi.fn()}
      />
    )
    expect(screen.queryByRole('checkbox', { name: 'Include contents of this folder' })).toBeNull()
  })
})
