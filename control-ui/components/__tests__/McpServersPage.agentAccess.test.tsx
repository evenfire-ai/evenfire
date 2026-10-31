import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import McpServersPage from '../../app/mcp-servers/page'
import * as api from '../../lib/api'
import type { ContextResource } from '../../lib/api'
import {
  contextRejectionResponse,
  okJsonResponse,
  unknownMcpServerBody,
} from '../../test/fixtures/contextMcpServerRejection'

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

// The table only exposes what this test drives: the bindings it was handed and the
// "add to agents" callback.
vi.mock('../McpServerTable', async () => {
  const React = await import('react')
  return {
    McpServerTable: (props: {
      agentBindingsByConnectorName: Record<string, Array<{ agents: Array<{ id: string }> }>>
      onAddToAgents: (
        server: { name: string; namespace: string },
        agents: Array<{ name: string; contextRef: string }>
      ) => Promise<boolean>
    }) =>
      React.createElement(
        'div',
        null,
        React.createElement(
          'output',
          { 'aria-label': 'srv agents' },
          (props.agentBindingsByConnectorName.srv ?? [])
            .flatMap(binding => binding.agents.map(agent => agent.id))
            .join(',')
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () =>
              void props.onAddToAgents({ name: 'srv', namespace: 'mcp-server' }, [
                { name: 'beta', contextRef: 'beta-ctx' },
                { name: 'gamma', contextRef: 'gamma-ctx' },
              ]),
          },
          'Add srv to agents'
        )
      ),
  }
})

// Context writes go through the real client over a stubbed fetch.
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getContexts: vi.fn(),
    getHosts: vi.fn(),
    getMcpServers: vi.fn(),
  }
})

let contexts: ContextResource[]
let fetchMock: ReturnType<typeof vi.fn>

function context(name: string, mcpServers: string[]): ContextResource {
  return {
    metadata: { name, namespace: 'default', resourceVersion: `rv-${name}` },
    spec: { contextId: name, mcpServers },
  } as ContextResource
}

beforeEach(() => {
  vi.clearAllMocks()
  contexts = [context('beta-ctx', []), context('gamma-ctx', [])]
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/contexts/beta-ctx')) {
      contexts = [context('beta-ctx', ['srv']), context('gamma-ctx', [])]
      return okJsonResponse(contexts[0])
    }
    return contextRejectionResponse(unknownMcpServerBody(['srv']))
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(api.getMcpServers).mockResolvedValue({
    items: [{ metadata: { name: 'srv', namespace: 'mcp-server' }, spec: {} }],
  })
  vi.mocked(api.getContexts).mockImplementation(async () => ({ items: contexts }))
  vi.mocked(api.getHosts).mockResolvedValue({
    items: [
      { metadata: { name: 'beta' }, spec: { host: 'Beta', contextRef: 'beta-ctx' } },
      { metadata: { name: 'gamma' }, spec: { host: 'Gamma', contextRef: 'gamma-ctx' } },
    ],
  } as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('McpServersPage — agent access refused mid-way', () => {
  it('reloads so the write that landed shows, and reports the vanished connector', async () => {
    render(<McpServersPage />)
    await waitFor(() => expect(api.getContexts).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Add srv to agents' }))

    expect(
      await screen.findByText('The connector srv no longer exists; reload the page and try again.')
    ).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'srv agents' })).toHaveTextContent('beta')
    expect(api.getContexts).toHaveBeenCalledTimes(2)
  })
})
