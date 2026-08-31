import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { buildContextResource } from '../../test/fixtures/contextResource'
import { McpServerTable } from '../McpServerTable'

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

function makeContextBinding(options: {
  name: string
  description?: string
  mcpServers?: string[]
}) {
  const context = buildContextResource({
    metadata: { name: options.name },
    spec: { description: options.description ?? '', mcpServers: options.mcpServers ?? [] },
  })
  return {
    name: context.metadata.name,
    description: context.spec.description,
    mcpServers: context.spec.mcpServers,
  }
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
      Array.from(document.querySelectorAll('.cu-connectors-table tbody tr > td:first-child')).map(
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
      'bravo-server',
      'zebra-server',
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
  it('renders a connector description in its own data column', () => {
    render(
      <McpServerTable
        items={[makeItem({ name: 'brave-search', description: 'Search the public web.' })]}
      />
    )

    const row = screen.getByText('brave-search').closest('tr')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('Search the public web.')
    expect(within(row!).getByTitle('Search the public web.')).toBeInTheDocument()
  })
})

describe('McpServerTable — connector access summaries', () => {
  it('renders ordinary rows without inline detail expansion', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(<McpServerTable items={items} />)

    expect(screen.getByText('airtable-server').closest('tr')).not.toHaveAttribute('aria-expanded')
    expect(screen.queryByRole('button', { name: /Expand connector/ })).toBeNull()
  })

  it('renders agents, teams, and users in marketplace-style access groups', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        accessByConnectorKey={{
          'mcp-server/airtable-server': {
            agents: [
              { id: 'agent-alpha', label: 'agent-alpha' },
              { id: 'bravo', label: 'bravo' },
              { id: 'charlie', label: 'charlie' },
              { id: 'delta', label: 'delta' },
              { id: 'echo', label: 'echo' },
              { id: 'foxtrot', label: 'foxtrot' },
            ],
            users: [{ id: 'user-1', label: 'Ada Lovelace' }],
            teams: [{ id: 'team-1', label: 'Research' }],
          },
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View access details' }))

    const access = screen.getByRole('dialog', { name: 'Access for airtable-server' })
    expect(access).toHaveTextContent('Agents')
    expect(access).toHaveTextContent('Teams')
    expect(access).toHaveTextContent('Users')

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

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector unused-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View access details' }))
    expect(screen.getByText('No agents linked.')).toBeInTheDocument()
    expect(screen.getByText('No teams linked.')).toBeInTheDocument()
    expect(screen.getByText('No users linked.')).toBeInTheDocument()
  })

  it('shows endpoint, image, transport, and managed as explicit columns', () => {
    const image =
      'us-central1-docker.pkg.dev/example-project/example/nginx-egress-proxy:sha-3cbdf33'
    const url = 'http://brave-search.mcp-server.svc.cluster.local:3000/mcp'
    render(<McpServerTable items={[makeItem({ name: 'airtable-server', image })]} />)

    expect(screen.getByRole('columnheader', { name: /Endpoint/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Image/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Transport/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Managed/i })).toBeInTheDocument()
    expect(screen.getByTitle(url)).toBeInTheDocument()
    expect(screen.getByTitle(image)).toBeInTheDocument()
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

describe('McpServerTable — context membership', () => {
  it('does not display a stale legacy contextRef without authoritative allowlist membership', () => {
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server', contextRef: 'removed-context' })]}
        contexts={[
          makeContextBinding({ name: 'removed-context' }),
          makeContextBinding({ name: 'active-context', mcpServers: ['another-server'] }),
        ]}
        accessByConnectorKey={{}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View access details' }))

    expect(screen.queryByText('removed-context')).not.toBeInTheDocument()
    expect(screen.getByText('No contexts linked.')).toBeInTheDocument()
    expect(screen.getByText('No agents linked.')).toBeInTheDocument()
    expect(screen.getByText('No teams linked.')).toBeInTheDocument()
    expect(screen.getByText('No users linked.')).toBeInTheDocument()
  })

  it('shows attached contexts and lets an operator remove the connector from one', async () => {
    const onRemoveFromContext = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        contexts={[
          makeContextBinding({
            name: 'research',
            description: 'Research tools',
            mcpServers: ['airtable-server'],
          }),
          makeContextBinding({ name: 'sales' }),
        ]}
        onAddToContexts={vi.fn().mockResolvedValue(undefined)}
        onRemoveFromContext={onRemoveFromContext}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from research' }))

    expect(onRemoveFromContext).toHaveBeenCalledWith(
      { namespace: 'mcp-server', name: 'airtable-server' },
      'research'
    )
  })

  it('uses the Context detail selection modal to add the connector to more contexts', async () => {
    const onAddToContexts = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        contexts={[
          makeContextBinding({ name: 'research', mcpServers: ['airtable-server'] }),
          makeContextBinding({ name: 'sales', description: 'Sales tools' }),
        ]}
        onAddToContexts={onAddToContexts}
        onRemoveFromContext={vi.fn().mockResolvedValue(undefined)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to contexts' }))

    const dialog = screen.getByRole('dialog', { name: 'Add connector to contexts' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.parentElement).toHaveClass('cu-modal-backdrop')
    expect(screen.getByLabelText('Contexts')).toBeInTheDocument()
    expect(screen.queryByText('No available contexts.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'sales' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to context' }))

    await waitFor(() =>
      expect(onAddToContexts).toHaveBeenCalledWith(
        { namespace: 'mcp-server', name: 'airtable-server' },
        ['sales']
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

    const editItem = await screen.findByRole('menuitem', { name: 'View details' })
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteItem).toHaveClass('eft-row-actions__item--danger')

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

    const editItem = screen.getByRole('menuitem', { name: 'View details' })
    const deletingItem = screen.getByRole('menuitem', { name: 'Deleting…' })

    expect(editItem).not.toBeDisabled()
    expect(deletingItem).toBeDisabled()
  })

  it('retains the access-details menu when edit and delete are unavailable', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(<McpServerTable items={items} />)
    expect(
      screen.getByRole('button', { name: 'Actions for connector airtable-server' })
    ).toBeInTheDocument()
  })
})
