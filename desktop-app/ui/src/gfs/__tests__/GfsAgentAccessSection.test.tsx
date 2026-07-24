// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsAgentAccessSection } from '../GfsAgentAccessSection'

/**
 * Per-agent GFS delegation section (Manage modal). Proves the read/write-only
 * permission cap, the `host:`-prefixed subject keys, and the inherit contract:
 * directories default inherit ON (a folder grant without inherit would silently
 * break the agent-reads-file journey); files never send inherit.
 */

afterEach(cleanup)

const agents = [
  { id: '1st:mcp-host/chatllm', name: 'chatllm' },
  { id: '1st:mcp-host/chatllm-stateless', name: 'chatllm-stateless' },
]

describe('GfsAgentAccessSection', () => {
  it('offers ONLY read and write permissions for agents', () => {
    render(
      <GfsAgentAccessSection agents={agents} isDirectory onGrantAgents={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Read' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Write' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Manage access' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Share' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Delete' })).toBeNull()
  })

  it('emits host:-prefixed subject keys for the selected agents', async () => {
    const onGrantAgents = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsAgentAccessSection agents={agents} isDirectory onGrantAgents={onGrantAgents} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'chatllm' }))
    fireEvent.click(screen.getByRole('button', { name: 'chatllm-stateless' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant agent access' }))

    await waitFor(() =>
      expect(onGrantAgents).toHaveBeenCalledWith(
        ['host:1st:mcp-host/chatllm', 'host:1st:mcp-host/chatllm-stateless'],
        ['read'],
        true
      )
    )
  })

  it('defaults the inherit toggle ON for directories and honors turning it off', async () => {
    const onGrantAgents = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsAgentAccessSection agents={agents} isDirectory onGrantAgents={onGrantAgents} />
    )

    const inherit = screen.getByRole('checkbox', { name: 'Include contents of this folder' })
    expect(inherit).toHaveProperty('checked', true)

    fireEvent.click(inherit)
    fireEvent.click(screen.getByRole('button', { name: 'chatllm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant agent access' }))

    await waitFor(() =>
      expect(onGrantAgents).toHaveBeenCalledWith(['host:1st:mcp-host/chatllm'], ['read'], false)
    )
  })

  it('hides the inherit toggle for files and always sends inherit false', async () => {
    const onGrantAgents = vi.fn().mockResolvedValue(undefined)
    render(
      <GfsAgentAccessSection agents={agents} isDirectory={false} onGrantAgents={onGrantAgents} />
    )

    expect(
      screen.queryByRole('checkbox', { name: 'Include contents of this folder' })
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'chatllm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant agent access' }))

    await waitFor(() =>
      expect(onGrantAgents).toHaveBeenCalledWith(['host:1st:mcp-host/chatllm'], ['read'], false)
    )
  })

  it('surfaces a mapped server verdict and keeps ALL selected agents on an atomic failure', async () => {
    // The bulk grant is all-or-nothing: a rejection means NO agent was granted,
    // so every selected agent stays selected for a retry (no partial-success).
    const onGrantAgents = vi
      .fn()
      .mockRejectedValue(new Error('403 Forbidden: managed_agent_permission_forbidden'))
    render(
      <GfsAgentAccessSection agents={agents} isDirectory onGrantAgents={onGrantAgents} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'chatllm' }))
    fireEvent.click(screen.getByRole('button', { name: 'chatllm-stateless' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grant agent access' }))

    await screen.findByText('Managed agents can only be granted read and write.')
    expect(onGrantAgents).toHaveBeenCalledTimes(1)
    expect(onGrantAgents).toHaveBeenCalledWith(
      ['host:1st:mcp-host/chatllm', 'host:1st:mcp-host/chatllm-stateless'],
      ['read'],
      true
    )
    // SelectableOption only sets aria-pressed="true" while selected — both stay.
    expect(
      screen.getByRole('button', { name: 'chatllm' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'chatllm-stateless' }).getAttribute('aria-pressed')
    ).toBe('true')
  })

  it('renders an empty notice when the caller has no grantable agents', () => {
    render(<GfsAgentAccessSection agents={[]} isDirectory onGrantAgents={vi.fn()} />)

    expect(screen.getByText('You have no agents that can be granted access.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Grant agent access' })).toBeNull()
  })
})
