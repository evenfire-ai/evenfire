import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import HostDetailsPage from '../../app/hosts/[name]/page'
import * as api from '../../lib/api'
import {
  buildContextResource,
  buildSharedContextScenario,
  materializeContextResource,
} from '../../test/fixtures/contextResource'
import { ToastProvider } from '../Toast'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let activeHostName = 'foo'

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: activeHostName, tab: 'connectors' }),
  usePathname: () => `/agents/${activeHostName}/connectors`,
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('../Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}))

vi.mock('../HostIdentityTab', () => ({
  HostIdentityTab: () => <div data-testid="identity-tab" />,
}))

vi.mock('../HostAccessTab', () => ({
  HostAccessTab: () => <div data-testid="access-tab" />,
}))

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn(),
  getHost: vi.fn(),
  getHostDetailBundle: vi.fn(),
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  getMcpServers: vi.fn(),
  isSilentApiError: vi.fn().mockReturnValue(false),
  updateContext: vi.fn(),
}))

const contextName = 'foo-12345'
const baseContext = buildContextResource({
  metadata: { name: contextName, resourceVersion: 'rv-context-1' },
  spec: {
    contextId: contextName,
    description: 'Connector context for agent foo',
    mcpServers: ['mcp-existing'],
  },
})

function setupApiMocks() {
  ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    host: {
      metadata: { name: activeHostName, resourceVersion: 'rv-host-1' },
      spec: {
        contextRef: contextName,
        host: 'Foo',
        model: { name: 'gpt-5.4-mini', provider: 'openai' },
      },
    },
    contexts: [baseContext],
    secrets: [],
    users: [],
    teams: [],
    agentUsers: [],
    agentTeams: [],
  })
  ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    metadata: { name: activeHostName },
    spec: {},
  })
  ;(api.getMcpServers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [
      { metadata: { name: 'mcp-existing' } },
      { metadata: { name: 'mcp-new' } },
      { metadata: { name: 'mcp-another' } },
    ],
  })
  ;(api.updateContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_name: string, payload: { spec: Record<string, unknown> }) => ({
      metadata: { name: contextName, resourceVersion: 'rv-context-2' },
      spec: payload.spec,
    })
  )
  ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})
}

function renderPage() {
  return rtlRender(
    <ToastProvider>
      <HostDetailsPage />
    </ToastProvider>
  )
}

afterEach(() => {
  cleanup()
  activeHostName = 'foo'
})

describe('HostDetailsPage connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupApiMocks()
  })

  it('adds connectors through the agent private context without showing its name', async () => {
    renderPage()

    expect(await screen.findByText('mcp-existing')).toBeInTheDocument()
    expect(screen.queryByText(contextName)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))
    await waitFor(() => expect(api.getMcpServers).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('option', { name: 'mcp-new' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add connector' })
    )

    await waitFor(() => expect(api.updateContext).toHaveBeenCalledTimes(1))
    expect(api.updateContext).toHaveBeenCalledWith(
      contextName,
      expect.objectContaining({
        metadata: { resourceVersion: 'rv-context-1' },
        spec: expect.objectContaining({
          description: 'Connector context for agent foo',
          mcpServers: ['mcp-existing', 'mcp-new'],
        }),
      })
    )
    expect(await screen.findByText('mcp-new')).toBeInTheDocument()
  })

  it('confirms connector removal and updates the private context membership', async () => {
    renderPage()

    const actionsButton = await screen.findByRole('button', {
      name: 'Actions for connector mcp-existing',
    })
    fireEvent.click(actionsButton)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove connector' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove connector' }))

    await waitFor(() => expect(api.updateContext).toHaveBeenCalledTimes(1))
    expect(api.updateContext).toHaveBeenCalledWith(
      contextName,
      expect.objectContaining({
        metadata: { resourceVersion: 'rv-context-1' },
        spec: expect.objectContaining({ mcpServers: [] }),
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Actions for connector mcp-existing' })
      ).toBeNull()
    )
  })

  it('keeps connector membership shared for two Hosts backed by one producer Context (R1-H1)', async () => {
    const scenario = buildSharedContextScenario({
      contextName: 'shared-connectors',
      description: 'Shared connector context for two agents',
      mcpServers: ['mcp-existing'],
      hostNames: ['foo', 'bar'],
    })
    let persistedContext = scenario.context

    // Previous-head reproduction (8c9e129a7ad4e7252bf8dae5a3820c08cb32ed5b):
    // the reviewed coverage mounted one Host with a partial hand-built Context.
    // That setup could pass without proving that two producer Hosts consume the
    // same persisted Context. Each response below is a fresh producer-shaped
    // Host + Context read, so a Host-local connector list cannot satisfy the
    // observable assertions.
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        const host = scenario.hosts[name as 'foo' | 'bar']
        // Model the producer's detail response: Contexts are resolved from the
        // Host's persisted reference, rather than injected into every Host
        // response regardless of its binding.
        const contexts =
          persistedContext.metadata.name === host.spec.contextRef ? [persistedContext] : []
        return {
          host,
          contexts,
          secrets: [],
          users: [],
          teams: [],
          agentUsers: [],
          agentTeams: [],
        }
      }
    )
    ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => ({ ...scenario.hosts[name as 'foo' | 'bar'] })
    )
    ;(api.updateContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _name: string,
        payload: { metadata: { resourceVersion: string }; spec: Record<string, unknown> }
      ) => {
        persistedContext = materializeContextResource(
          {
            metadata: { name: 'shared-connectors' },
            spec: {
              contextId: String(payload.spec.contextId || 'shared-connectors'),
              description: String(payload.spec.description || ''),
              mcpServers: Array.isArray(payload.spec.mcpServers)
                ? payload.spec.mcpServers.map(String)
                : [],
            },
          },
          {
            metadata: {
              ...persistedContext.metadata,
              resourceVersion: 'rv-context-shared-2',
            },
            spec: payload.spec,
          }
        )
        return persistedContext
      }
    )

    // Both Hosts render the same producer Context before any mutation. This
    // is deliberately checked through the UI, not by inspecting contextRef.
    activeHostName = 'foo'
    renderPage()
    expect(await screen.findByText('mcp-existing')).toBeInTheDocument()

    cleanup()
    activeHostName = 'bar'
    renderPage()
    expect(await screen.findByText('mcp-existing')).toBeInTheDocument()

    cleanup()
    activeHostName = 'foo'
    renderPage()
    expect(await screen.findByText('mcp-existing')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))
    await waitFor(() => expect(api.getMcpServers).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('option', { name: 'mcp-new' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add connector' })
    )
    await waitFor(() =>
      expect(api.updateContext).toHaveBeenCalledWith(
        'shared-connectors',
        expect.objectContaining({
          metadata: { resourceVersion: 'rv-context-shared-1' },
          spec: expect.objectContaining({
            contextId: 'shared-connectors',
            mcpServers: ['mcp-existing', 'mcp-new'],
          }),
        })
      )
    )

    cleanup()
    activeHostName = 'bar'
    renderPage()

    // Regression assertion: a second Host referencing the same Context sees
    // the membership written through the first Host, without exposing the
    // implementation Context name in the Connectors UI.
    expect(await screen.findByText('mcp-new')).toBeInTheDocument()
    expect(screen.queryByText('shared-connectors')).not.toBeInTheDocument()
    expect(api.getHostDetailBundle).toHaveBeenLastCalledWith('bar')
  })
})
