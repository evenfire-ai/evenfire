import { afterEach, describe, expect, it } from 'vitest'
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
  conditions?: McpServerCondition[] | undefined
  hasStatus?: boolean
}) {
  const item: {
    metadata: { name: string; namespace: string }
    spec: {
      image: string
      contextRef: string
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

describe('McpServerTable — connector access summaries', () => {
  it('renders agent initials and overflow count for connector access', () => {
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

    expect(screen.getByLabelText('6 agents with access')).toBeInTheDocument()
    expect(screen.queryByText('6 agents')).not.toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByLabelText('6 agents with access')).toHaveAttribute(
      'data-tooltip',
      'Agents: agent-alpha, bravo, charlie, delta, echo, foxtrot\nUsers: Ada Lovelace\nTeams: Research'
    )
  })

  it('renders an empty access state when no agents are mapped', () => {
    const items = [makeItem({ name: 'unused-server' })]
    render(<McpServerTable items={items} />)

    expect(screen.getByText('No agents')).toBeInTheDocument()
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
