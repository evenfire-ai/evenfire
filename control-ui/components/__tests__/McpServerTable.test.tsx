import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('renders full principal names as chips in the expanded details', () => {
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

    fireEvent.click(screen.getByText('airtable-server').closest('tr')!)

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
    expect(screen.getByText('No access assigned')).toBeInTheDocument()
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
  it('shows attached contexts and lets an operator remove the connector from one', async () => {
    const onRemoveFromContext = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        contexts={[
          { name: 'research', description: 'Research tools', mcpServers: ['airtable-server'] },
          { name: 'sales', mcpServers: [] },
        ]}
        onAddToContexts={vi.fn().mockResolvedValue(undefined)}
        onRemoveFromContext={onRemoveFromContext}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand connector airtable-server' }))

    expect(screen.getByText('Available in contexts')).toBeInTheDocument()
    expect(screen.getByText('research')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove connector airtable-server from context research',
      })
    )

    expect(onRemoveFromContext).toHaveBeenCalledWith(
      { namespace: 'mcp-server', name: 'airtable-server' },
      'research'
    )
  })

  it('uses the Context detail selection modal to add the connector to more contexts', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        contexts={[
          { name: 'research', mcpServers: ['airtable-server'] },
          { name: 'sales', description: 'Sales tools', mcpServers: [] },
        ]}
        onAddToContexts={vi.fn().mockResolvedValue(undefined)}
        onRemoveFromContext={vi.fn().mockResolvedValue(undefined)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand connector airtable-server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add contexts' }))

    expect(screen.getByRole('dialog', { name: 'Add connector to contexts' })).toBeInTheDocument()
    expect(screen.getByText('Contexts')).toBeInTheDocument()
    expect(screen.getByText('No available contexts.')).not.toBeInTheDocument()
  })
})
