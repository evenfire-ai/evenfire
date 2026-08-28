import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { McpServerTable } from '../McpServerTable'
import type { ConnectorAgentBinding } from '../McpServerTable.types'

afterEach(() => {
  cleanup()
})

type McpServerCondition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}

function makeItem(overrides: {
  name?: string
  namespace?: string
  image?: string
  contextRef?: string
  description?: string
  transportType?: 'sse' | 'streamableHttp' | 'stdio'
  enabled?: boolean
  conditions?: McpServerCondition[] | undefined
  hasStatus?: boolean
}) {
  const item: {
    metadata: { name: string; namespace: string }
    spec: {
      image: string
      contextRef: string
      description?: string
      enabled?: boolean
      transport: { type: 'sse' | 'streamableHttp' | 'stdio'; url: string }
    }
    status?: { conditions?: McpServerCondition[] }
  } = {
    metadata: {
      name: overrides.name ?? 'brave-search',
      namespace: overrides.namespace ?? 'mcp-server',
    },
    spec: {
      image: overrides.image ?? 'ghcr.io/example/mcp:1.0',
      contextRef: overrides.contextRef ?? 'context1',
      description: overrides.description,
      enabled: overrides.enabled,
      transport: {
        type: overrides.transportType ?? 'streamableHttp',
        url: 'http://brave-search.mcp-server.svc.cluster.local:3000/mcp',
      },
    },
  }
  if (overrides.hasStatus !== false) {
    item.status = { conditions: overrides.conditions }
  }
  return item
}

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge precedence
// ─────────────────────────────────────────────────────────────────────────────
describe('McpServerTable — StatusBadge precedence', () => {
  it('renders a green Ready badge when Ready=True is present', () => {
    const items = [
      makeItem({
        conditions: [{ type: 'Ready', status: 'True', reason: 'AllGood' }],
      }),
    ]
    render(<McpServerTable items={items} />)
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('renders a red Missing Secret badge with tooltip when SecretResolved=False', () => {
    const items = [
      makeItem({
        conditions: [
          {
            type: 'SecretResolved',
            status: 'False',
            reason: 'SecretNotFound',
            message: 'Secret foo not found',
          },
          { type: 'Ready', status: 'False', reason: 'DependenciesNotReady' },
        ],
      }),
    ]
    render(<McpServerTable items={items} />)
    const badge = screen.getByText('Missing Secret')
    expect(badge).toBeInTheDocument()
    expect(screen.getByTitle('Secret foo not found')).toBeInTheDocument()
  })

  it('renders a yellow Pending badge when conditions exist but no Ready=True nor SecretResolved=False', () => {
    const items = [
      makeItem({
        conditions: [{ type: 'SomeOther', status: 'Unknown', reason: 'Initializing' }],
      }),
    ]
    render(<McpServerTable items={items} />)
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('renders a gray Unknown badge when status is undefined', () => {
    const items = [makeItem({ hasStatus: false })]
    render(<McpServerTable items={items} />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Search filter by condition text
// ─────────────────────────────────────────────────────────────────────────────
describe('McpServerTable — search filter by condition text', () => {
  it('filters rows when searching by condition reason (SecretNotFound)', () => {
    const items = [
      makeItem({
        name: 'broken-server',
        conditions: [
          {
            type: 'SecretResolved',
            status: 'False',
            reason: 'SecretNotFound',
            message: 'Missing mongo-creds',
          },
        ],
      }),
      makeItem({
        name: 'healthy-server',
        conditions: [{ type: 'Ready', status: 'True', reason: 'AllGood' }],
      }),
    ]
    render(<McpServerTable items={items} />)

    // Both rows present before search
    expect(screen.getByText('broken-server')).toBeInTheDocument()
    expect(screen.getByText('healthy-server')).toBeInTheDocument()

    const search = screen.getByLabelText('Search connectors') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'SecretNotFound' } })

    expect(screen.getByText('broken-server')).toBeInTheDocument()
    expect(screen.queryByText('healthy-server')).not.toBeInTheDocument()
  })

  // Regression (caught live by the qa-recorder connectors-search-agent
  // journey): the page's summary.agents must carry the binding agents so the
  // search haystack keeps matching agent display names after the Phase-1
  // agent-access rework.
  it('keeps a row when searching by an agent display name from the access summary', () => {
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server' })]}
        accessByConnectorKey={{
          'mcp-server/airtable-server': {
            agents: [{ id: 'research-agent', label: 'Research Agent' }],
            users: [],
            teams: [],
          },
        }}
      />
    )

    const search = screen.getByLabelText('Search connectors') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Research Agent' } })
    expect(screen.getByText('airtable-server')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'no-such-agent' } })
    expect(screen.queryByText('airtable-server')).not.toBeInTheDocument()
  })
})

describe('McpServerTable — column sorting', () => {
  it('sorts connectors by name, enabled state, and status from their headers', () => {
    const items = [
      makeItem({
        name: 'zebra-server',
        enabled: true,
        conditions: [{ type: 'Ready', status: 'True' }],
      }),
      makeItem({ name: 'alpha-server', enabled: false, hasStatus: false }),
      makeItem({
        name: 'bravo-server',
        enabled: true,
        conditions: [{ type: 'SomeOther', status: 'Unknown' }],
      }),
      makeItem({
        name: 'charlie-server',
        enabled: false,
        conditions: [{ type: 'SecretResolved', status: 'False' }],
      }),
    ]
    render(<McpServerTable items={items} />)

    const listedNames = () =>
      Array.from(document.querySelectorAll('.cu-connectors-table .cu-expandable-row__name')).map(
        element => element.textContent
      )

    fireEvent.click(screen.getByRole('button', { name: 'Sort by name ascending' }))
    expect(listedNames()).toEqual([
      'alpha-server',
      'bravo-server',
      'charlie-server',
      'zebra-server',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by enabled ascending' }))
    expect(listedNames()).toEqual([
      'alpha-server',
      'charlie-server',
      'zebra-server',
      'bravo-server',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by status ascending' }))
    expect(listedNames()).toEqual([
      'charlie-server',
      'bravo-server',
      'zebra-server',
      'alpha-server',
    ])
  })
})

describe('McpServerTable — marketplace-aligned rows', () => {
  it('renders a connector description below its name in the list row', () => {
    render(
      <McpServerTable
        items={[makeItem({ name: 'brave-search', description: 'Search the public web.' })]}
      />
    )

    const row = screen.getByText('brave-search').closest('tr')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('Search the public web.')
    expect(row?.querySelector('.cu-registry-description')).toHaveAttribute(
      'title',
      'Search the public web.'
    )
  })
})

describe('McpServerTable — connector access summaries', () => {
  it('exposes expandable rows as named buttons with their current state', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(<McpServerTable items={items} />)

    const row = screen.getByRole('button', { name: 'Expand connector airtable-server' })
    expect(row).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(row)

    expect(
      screen.getByRole('button', { name: 'Collapse connector airtable-server' })
    ).toHaveAttribute('aria-expanded', 'true')
  })

  it('renders agents, teams, and users in marketplace-style access groups', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        accessByConnectorKey={{
          'mcp-server/airtable-server': {
            agents: [],
            users: [{ id: 'user-1', label: 'Ada Lovelace' }],
            teams: [{ id: 'team-1', label: 'Research' }],
          },
        }}
        agentBindingsByConnectorName={{
          'airtable-server': [
            {
              contextRef: 'ctx-research',
              agents: [
                { id: 'agent-alpha', label: 'agent-alpha' },
                { id: 'bravo', label: 'bravo' },
                { id: 'charlie', label: 'charlie' },
              ],
            },
            {
              contextRef: 'ctx-sales',
              agents: [
                { id: 'delta', label: 'delta' },
                { id: 'echo', label: 'echo' },
                { id: 'foxtrot', label: 'foxtrot' },
              ],
            },
          ],
        }}
      />
    )

    fireEvent.click(screen.getByText('airtable-server').closest('tr')!)

    const access = screen.getByRole('region', { name: 'Connector access' })
    expect(access).toHaveTextContent('Agents')
    expect(access).toHaveTextContent('Teams')
    expect(access).toHaveTextContent('Users')
    expect(screen.queryByText('ctx-research')).not.toBeInTheDocument()
    expect(screen.queryByText('ctx-sales')).not.toBeInTheDocument()

    const agentsHeading = screen.getByRole('heading', { name: 'Agents' })
    expect(agentsHeading.parentElement).toHaveTextContent('6')

    for (const label of [
      'agent-alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'Ada Lovelace',
      'Research',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('renders an empty access state when no principals are mapped', () => {
    const items = [makeItem({ name: 'unused-server' })]
    render(<McpServerTable items={items} />)

    fireEvent.click(screen.getByText('unused-server').closest('tr')!)
    expect(screen.getByText('No agents have access yet.')).toBeInTheDocument()
    expect(screen.getByText('No teams have access.')).toBeInTheDocument()
    expect(screen.getByText('No users have access.')).toBeInTheDocument()
  })

  it('orders URL, image, transport, and managed together and copies both full URLs', async () => {
    const image =
      'us-central1-docker.pkg.dev/example-project/example/nginx-egress-proxy:sha-3cbdf33'
    const url = 'http://brave-search.mcp-server.svc.cluster.local:3000/mcp'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server', image, contextRef: 'ctx-private-plumbing' })]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand connector airtable-server' }))

    const metadata = document.querySelector('.cu-connector-detail__metadata')
    expect(metadata).not.toBeNull()
    const labels = Array.from(metadata!.querySelectorAll('.cu-expandable-field__label')).map(
      label => label.textContent
    )
    expect(labels).toEqual(['URL', 'Image', 'Transport', 'Managed'])
    expect(metadata).not.toHaveTextContent('ctx-private-plumbing')

    const compactUrl = screen.getByTitle(url)
    expect(compactUrl.textContent).toContain('...')
    expect(compactUrl).toHaveAttribute('href', url)
    const compactImage = screen.getByTitle(image)
    expect(compactImage.textContent).toContain('...')
    expect(compactImage.textContent).not.toBe(image)

    fireEvent.click(screen.getByRole('button', { name: 'Copy image URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(image))
    expect(screen.getByRole('button', { name: 'image URL copied' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url))
    expect(screen.getByRole('button', { name: 'URL copied' })).toBeInTheDocument()
  })

  it('filters rows by agent, user, and team access labels', () => {
    const items = [
      makeItem({ name: 'airtable-server' }),
      makeItem({ name: 'search-server', contextRef: 'context2' }),
    ]
    render(
      <McpServerTable
        items={items}
        accessByConnectorKey={{
          'mcp-server/airtable-server': {
            agents: [{ id: 'agent-alpha', label: 'agent-alpha' }],
            users: [{ id: 'user-1', label: 'Ada Lovelace' }],
            teams: [{ id: 'team-1', label: 'Research' }],
          },
          'mcp-server/search-server': {
            agents: [{ id: 'agent-beta', label: 'agent-beta' }],
            users: [{ id: 'user-2', label: 'Grace Hopper' }],
            teams: [{ id: 'team-2', label: 'Operations' }],
          },
        }}
      />
    )

    const search = screen.getByLabelText('Search connectors') as HTMLInputElement

    fireEvent.change(search, { target: { value: 'Research' } })
    expect(screen.getByText('airtable-server')).toBeInTheDocument()
    expect(screen.queryByText('search-server')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'Grace Hopper' } })
    expect(screen.queryByText('airtable-server')).not.toBeInTheDocument()
    expect(screen.getByText('search-server')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'agent-alpha' } })
    expect(screen.getByText('airtable-server')).toBeInTheDocument()
    expect(screen.queryByText('search-server')).not.toBeInTheDocument()
  })
})

describe('McpServerTable — agent membership', () => {
  it('does not display a stale legacy contextRef when no agent bindings exist', () => {
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server', contextRef: 'removed-context' })]}
        agentBindingsByConnectorName={{}}
        accessByConnectorKey={{}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand connector airtable-server' }))

    expect(screen.queryByText('removed-context')).not.toBeInTheDocument()
    expect(screen.getByText('No agents have access yet.')).toBeInTheDocument()
    expect(screen.getByText('No teams have access.')).toBeInTheDocument()
    expect(screen.getByText('No users have access.')).toBeInTheDocument()
  })

  it('shows bound agents and lets an operator remove the connector from one', async () => {
    const onRemoveFromAgents = vi.fn().mockResolvedValue(undefined)
    const researchBinding: ConnectorAgentBinding = {
      contextRef: 'ctx-research',
      agents: [{ id: 'research-agent', label: 'research-agent' }],
    }
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server' })]}
        agentBindingsByConnectorName={{ 'airtable-server': [researchBinding] }}
        onRemoveFromAgents={onRemoveFromAgents}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand connector airtable-server' }))

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByText('research-agent')).toBeInTheDocument()
    expect(screen.queryByText('ctx-research')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove connector airtable-server from agent research-agent',
      })
    )

    expect(onRemoveFromAgents).toHaveBeenCalledWith(
      { namespace: 'mcp-server', name: 'airtable-server' },
      researchBinding
    )
  })

  it('uses the agent selection modal to give more agents access to the connector', async () => {
    const onAddToAgents = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        agentBindingsByConnectorName={{
          'airtable-server': [
            {
              contextRef: 'ctx-research',
              agents: [{ id: 'research-agent', label: 'research-agent' }],
            },
          ],
        }}
        agentTargets={[
          { name: 'research-agent', label: 'research-agent', contextRef: 'ctx-research' },
          { name: 'sales-agent', label: 'sales-agent', contextRef: 'ctx-sales' },
          { name: 'support-agent', label: 'support-agent', contextRef: 'ctx-support' },
        ]}
        onAddToAgents={onAddToAgents}
        onRemoveFromAgents={vi.fn().mockResolvedValue(undefined)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand connector airtable-server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add agents' }))

    const dialog = screen.getByRole('dialog', { name: 'Give agents access to this connector' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.parentElement).toHaveClass('cu-modal-backdrop')
    expect(screen.getByLabelText('Agents')).toBeInTheDocument()
    expect(screen.queryByText('No other agents available.')).not.toBeInTheDocument()

    // Agents already bound to the connector are not offered again.
    expect(screen.queryByRole('option', { name: 'research-agent' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'sales-agent' }))
    expect(screen.getByRole('button', { name: 'Add to agent' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'support-agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to agents' }))

    await waitFor(() =>
      expect(onAddToAgents).toHaveBeenCalledWith(
        { namespace: 'mcp-server', name: 'airtable-server' },
        [
          { name: 'sales-agent', contextRef: 'ctx-sales' },
          { name: 'support-agent', contextRef: 'ctx-support' },
        ]
      )
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Row actions kebab
// ─────────────────────────────────────────────────────────────────────────────
describe('McpServerTable — row actions kebab', () => {
  it('exposes Edit and Remove via a single kebab menu per row and routes the click to the matching handler', async () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]

    render(<McpServerTable items={items} onEdit={onEdit} onDelete={onDelete} />)

    const trigger = screen.getByRole('button', { name: 'Actions for connector airtable-server' })
    fireEvent.click(trigger)

    const editItem = await screen.findByRole('menuitem', { name: 'Edit' })
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteItem).toHaveClass('cu-kebab__item--danger')

    fireEvent.click(editItem)
    expect(onEdit).toHaveBeenCalledWith({ namespace: 'mcp-server', name: 'airtable-server' })
    expect(onDelete).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() =>
      expect(onDelete).toHaveBeenCalledWith({ namespace: 'mcp-server', name: 'airtable-server' })
    )
  })

  it('disables only the Remove item while a delete is in flight and renames it to Deleting…', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        onEdit={vi.fn()}
        onDelete={onDelete}
        deletingKey="mcp-server/airtable-server"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))

    const editItem = screen.getByRole('menuitem', { name: 'Edit' })
    const deletingItem = screen.getByRole('menuitem', { name: 'Deleting…' })

    expect(editItem).not.toBeDisabled()
    expect(deletingItem).toBeDisabled()
  })

  it('renders no kebab when neither onEdit nor onDelete is provided', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(<McpServerTable items={items} />)
    expect(
      screen.queryByRole('button', { name: 'Actions for connector airtable-server' })
    ).not.toBeInTheDocument()
  })
})
