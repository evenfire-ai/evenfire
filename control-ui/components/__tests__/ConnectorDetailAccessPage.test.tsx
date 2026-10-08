import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ContextResource, HostResource } from '@lib/api'
import * as api from '@lib/api'
import { ConnectorDetailAccessProvider } from '../ConnectorDetailAccessProvider'
import { ConnectorDetailPage } from '../ConnectorDetailPage'
import { ConnectorDetailProvider } from '../ConnectorDetailProvider'

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  params: { name: 'search', tab: 'agents' } as { name: string; tab?: string },
  segment: 'agents' as string | null,
}))

let contexts: ContextResource[] = []
let hosts: HostResource[] = []

function resetResources() {
  contexts = [
    {
      metadata: { name: 'alpha-context', resourceVersion: '1' },
      spec: { contextId: 'alpha-context', mcpServers: ['search'], sharedFileSystems: [] },
    },
    {
      metadata: { name: 'beta-context', resourceVersion: '3' },
      spec: { contextId: 'beta-context', mcpServers: [], sharedFileSystems: [] },
    },
  ]
  hosts = [
    {
      metadata: { name: 'agent-alpha' },
      spec: { host: 'Alpha Agent', contextRef: 'alpha-context' },
    },
    {
      metadata: { name: 'agent-beta' },
      spec: { host: 'Beta Agent', contextRef: 'beta-context' },
    },
  ]
}

function renderDetail() {
  return render(
    <ConnectorDetailProvider>
      <ConnectorDetailAccessProvider>
        <ConnectorDetailPage />
      </ConnectorDetailAccessProvider>
    </ConnectorDetailProvider>
  )
}

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useSelectedLayoutSegment: () => navigation.segment,
  useRouter: () => ({ push: navigation.push }),
}))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  getMcpServer: vi.fn(),
  getContexts: vi.fn(async () => ({ items: contexts })),
  getHosts: vi.fn(async () => ({ items: hosts })),
  getAgentUsers: vi.fn(async (name: string) => ({
    items:
      name === 'agent-alpha'
        ? [{ id: 'user-ada', displayName: 'Ada' }]
        : [{ id: 'user-grace', displayName: 'Grace' }],
  })),
  getAgentTeams: vi.fn(async (name: string) => ({
    items:
      name === 'agent-alpha'
        ? [{ id: 'team-growth', name: 'Growth' }]
        : [{ id: 'team-research', name: 'Research' }],
  })),
  updateContext: vi.fn(async (name: string, payload: { spec: { mcpServers: string[] } }) => {
    contexts = contexts.map(context =>
      context.metadata?.name === name
        ? {
            ...context,
            metadata: { ...context.metadata, resourceVersion: '2' },
            spec: { ...context.spec, ...payload.spec },
          }
        : context
    )
    return contexts.find(context => context.metadata?.name === name)
  }),
}))

beforeEach(() => {
  resetResources()
  vi.clearAllMocks()
  navigation.params = { name: 'search', tab: 'agents' }
  navigation.segment = 'agents'
  vi.mocked(api.getMcpServer).mockResolvedValue({
    metadata: { name: 'search', namespace: 'mcp-server' },
    spec: { description: 'Search the public web' },
    status: { conditions: [] },
  })
})

afterEach(() => cleanup())

describe('connector detail access tabs', () => {
  it('shows read-only derived User and Team tables without add or remove actions', async () => {
    const { rerender } = renderDetail()
    expect(await screen.findByRole('link', { name: 'Alpha Agent' })).toBeVisible()

    navigation.params = { name: 'search', tab: 'users' }
    navigation.segment = 'users'
    rerender(
      <ConnectorDetailProvider>
        <ConnectorDetailAccessProvider>
          <ConnectorDetailPage />
        </ConnectorDetailAccessProvider>
      </ConnectorDetailProvider>
    )
    expect(await screen.findByRole('link', { name: 'Ada' })).toHaveAttribute(
      'href',
      '/users-and-teams/users/user-ada/agents'
    )
    expect(screen.getByText(/derived from the agents each user can access/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add agent' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /actions for connector access/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /remove/i })).not.toBeInTheDocument()

    navigation.params = { name: 'search', tab: 'teams' }
    navigation.segment = 'teams'
    rerender(
      <ConnectorDetailProvider>
        <ConnectorDetailAccessProvider>
          <ConnectorDetailPage />
        </ConnectorDetailAccessProvider>
      </ConnectorDetailProvider>
    )
    expect(await screen.findByRole('link', { name: 'Growth' })).toHaveAttribute(
      'href',
      '/users-and-teams/teams/team-growth/agents'
    )
    expect(screen.getByText(/derived from the agents assigned to each team/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add agent' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /actions for connector access/i })
    ).not.toBeInTheDocument()
    expect(api.getMcpServer).toHaveBeenCalledTimes(1)
    expect(api.getContexts).toHaveBeenCalledTimes(1)
  })

  it('adds only through Agents and refreshes the derived user/team summaries without reloading connector details', async () => {
    const { rerender } = renderDetail()
    expect(await screen.findByRole('link', { name: 'Alpha Agent' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add agent' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))

    const dialog = screen.getByRole('dialog', { name: 'Give agents access to this connector' })
    expect(within(dialog).getByRole('checkbox', { name: /Beta Agent/ })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Beta Agent/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to agent' }))

    await waitFor(() => {
      expect(api.updateContext).toHaveBeenCalledWith(
        'beta-context',
        expect.objectContaining({
          metadata: { resourceVersion: '3' },
          spec: expect.objectContaining({ mcpServers: ['search'] }),
        })
      )
    })
    expect(await screen.findByRole('link', { name: 'Beta Agent' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(/Users and Teams summaries now reflect/)

    navigation.params = { name: 'search', tab: 'users' }
    navigation.segment = 'users'
    rerender(
      <ConnectorDetailProvider>
        <ConnectorDetailAccessProvider>
          <ConnectorDetailPage />
        </ConnectorDetailAccessProvider>
      </ConnectorDetailProvider>
    )
    expect(await screen.findByRole('link', { name: 'Grace' })).toBeVisible()

    navigation.params = { name: 'search', tab: 'teams' }
    navigation.segment = 'teams'
    rerender(
      <ConnectorDetailProvider>
        <ConnectorDetailAccessProvider>
          <ConnectorDetailPage />
        </ConnectorDetailAccessProvider>
      </ConnectorDetailProvider>
    )
    expect(await screen.findByRole('link', { name: 'Research' })).toBeVisible()
    expect(api.getMcpServer).toHaveBeenCalledTimes(1)
    expect(api.getContexts).toHaveBeenCalledTimes(2)
  })

  it('keeps the existing agent removal confirmation for a shared agent context', async () => {
    contexts = [
      {
        metadata: { name: 'shared-context', resourceVersion: '9' },
        spec: { contextId: 'shared-context', mcpServers: ['search'], sharedFileSystems: [] },
      },
    ]
    hosts.splice(
      0,
      hosts.length,
      {
        metadata: { name: 'agent-alpha' },
        spec: { host: 'Alpha Agent', contextRef: 'shared-context' },
      },
      {
        metadata: { name: 'agent-beta' },
        spec: { host: 'Beta Agent', contextRef: 'shared-context' },
      }
    )
    const { rerender } = renderDetail()
    const row = await screen.findByRole('row', { name: /Alpha Agent, Beta Agent/ })
    fireEvent.click(within(row).getByRole('button', { name: /actions for connector access/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /remove from 2 agents/i }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      /change applies to all of them/
    )
    expect(api.updateContext).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.updateContext).toHaveBeenCalledTimes(1))
    expect(api.updateContext).toHaveBeenCalledWith(
      'shared-context',
      expect.objectContaining({
        metadata: { resourceVersion: '9' },
        spec: expect.objectContaining({ mcpServers: [] }),
      })
    )
    expect(await screen.findByText('No agents have access to this connector.')).toBeVisible()

    navigation.params = { name: 'search', tab: 'users' }
    navigation.segment = 'users'
    rerender(
      <ConnectorDetailProvider>
        <ConnectorDetailAccessProvider>
          <ConnectorDetailPage />
        </ConnectorDetailAccessProvider>
      </ConnectorDetailProvider>
    )
    expect(await screen.findByText('No users have access through an assigned agent.')).toBeVisible()
  })

  it('keeps Add agent disabled when access sources fail before an initial snapshot loads', async () => {
    vi.mocked(api.getContexts).mockRejectedValueOnce(new Error('Context access is unavailable.'))
    renderDetail()

    expect(await screen.findByText('Context access is unavailable.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add agent' })).toBeDisabled()
    expect(
      screen.queryByRole('dialog', { name: 'Give agents access to this connector' })
    ).not.toBeInTheDocument()
  })
})
