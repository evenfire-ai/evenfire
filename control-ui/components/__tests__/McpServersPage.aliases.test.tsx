import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import McpServersPage from '../../app/mcp-servers/page'
import * as api from '../../lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn().mockResolvedValue(true), confirmDialog: null }),
}))

vi.mock('../DashboardLayout', async () => {
  const React = await import('react')
  return {
    DashboardLayout: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
  }
})

vi.mock('../Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../McpServerTable', async () => {
  const React = await import('react')
  return {
    McpServerTable: (props: {
      agentBindingsByConnectorName: Record<
        string,
        Array<{
          agents: Array<{ id: string; label: string }>
          contextRef: string
        }>
      >
      onAddToAgents: (
        server: { name: string; namespace: string },
        agents: Array<{ name: string; contextRef: string }>
      ) => Promise<void>
      onRemoveFromAgents: (
        server: { name: string; namespace: string },
        binding: {
          agents: Array<{ id: string; label: string }>
          contextRef: string
        }
      ) => Promise<void>
    }) => {
      const binding = props.agentBindingsByConnectorName.search?.[0]
      return React.createElement(
        'div',
        null,
        React.createElement(
          'span',
          null,
          `owners:${binding?.agents.map(agent => agent.label).join(',') || 'none'}`
        ),
        React.createElement(
          'button',
          {
            onClick: () =>
              props.onAddToAgents({ name: 'new-search', namespace: 'mcp-server' }, [
                { name: 'agent-alpha', contextRef: 'ctx-wire' },
              ]),
            type: 'button',
          },
          'add alias connector'
        ),
        binding
          ? React.createElement(
              'button',
              {
                onClick: () =>
                  props.onRemoveFromAgents({ name: 'search', namespace: 'mcp-server' }, binding),
                type: 'button',
              },
              'remove alias connector'
            )
          : null
      )
    },
  }
})

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
  getAgentTeams: vi.fn().mockResolvedValue({ items: [] }),
  getAgentUsers: vi.fn().mockResolvedValue({ items: [] }),
  getContexts: vi.fn(),
  getHosts: vi.fn(),
  getMcpServers: vi.fn(),
  isSilentApiError: vi.fn().mockReturnValue(false),
  updateContext: vi.fn().mockResolvedValue({}),
}))

describe('Installed Connectors Context aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getMcpServers).mockResolvedValue({
      items: [
        { metadata: { name: 'search', namespace: 'mcp-server' }, spec: {} },
        { metadata: { name: 'new-search', namespace: 'mcp-server' }, spec: {} },
      ],
    })
    vi.mocked(api.getContexts).mockResolvedValue({
      items: [
        {
          metadata: { name: 'ctx-resource', resourceVersion: 'rv-1' },
          spec: { contextId: 'ctx-wire', mcpServers: ['search'] },
        },
      ],
    })
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [
        {
          metadata: { name: 'agent-alpha' },
          spec: { contextRef: 'ctx-wire', host: 'Agent Alpha' },
        },
      ],
    })
  })

  it('shows the owner and uses the resource name for add and remove mutations', async () => {
    render(<McpServersPage />)

    expect(await screen.findByText('owners:Agent Alpha')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'add alias connector' }))
    await waitFor(() => expect(api.updateContext).toHaveBeenCalledTimes(1))
    expect(api.updateContext).toHaveBeenLastCalledWith(
      'ctx-resource',
      expect.objectContaining({
        metadata: { resourceVersion: 'rv-1' },
        spec: expect.objectContaining({
          contextId: 'ctx-wire',
          mcpServers: ['search', 'new-search'],
        }),
      })
    )

    vi.mocked(api.updateContext).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'remove alias connector' }))
    await waitFor(() => expect(api.updateContext).toHaveBeenCalledTimes(1))
    expect(api.updateContext).toHaveBeenLastCalledWith(
      'ctx-resource',
      expect.objectContaining({
        metadata: { resourceVersion: 'rv-1' },
        spec: expect.objectContaining({ contextId: 'ctx-wire', mcpServers: [] }),
      })
    )
  })
})
