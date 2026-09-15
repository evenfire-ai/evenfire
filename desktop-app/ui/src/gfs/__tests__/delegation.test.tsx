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
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Access role for selected recipients' })).toBeNull()

    fireEvent.focus(screen.getByRole('combobox', { name: PICKER_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Access role for selected recipients' }))
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    // Files never send inherit.
    await waitFor(() =>
      expect(onGrant).toHaveBeenCalledWith(['user:u2'], ['read', 'manage_acl'], false)
    )
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
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

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
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Access role for selected recipients' })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    await screen.findByText('Some selected subjects are invalid and were rejected.')
    expect(onGrant).toHaveBeenCalledTimes(1)
    expect(onGrant).toHaveBeenCalledWith(['user:successful', 'team:blocked'], ['read'], false)
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
      />
    )

    fireEvent.focus(screen.getByRole('combobox', { name: PICKER_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: /chatllm/ }))

    expect(screen.getByText(/use read\/write access only/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Access role for selected recipients' }))
    expect(screen.getByRole('option', { name: 'Read' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'Editor' }))

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() =>
      expect(onGrant).toHaveBeenCalledWith(['host:1st:mcp-host/chatllm'], ['read', 'write'], false)
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

    const picker = screen.getByRole('combobox', { name: PICKER_LABEL })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    const toggle = screen.getByRole('checkbox', { name: 'Include contents of this folder' })
    expect(toggle).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(onGrant).toHaveBeenCalledWith(['user:u2'], ['read'], true))

    // The panel clears the selection after a successful grant, so re-pick before
    // proving the unchecked toggle sends inherit=false.
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Delegate User/ }))
    const secondToggle = screen.getByRole('checkbox', { name: 'Include contents of this folder' })
    fireEvent.click(secondToggle)
    expect(secondToggle).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
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
