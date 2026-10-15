import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  authType?: string | null
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
      auth?: { type?: string | null } | null
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
      ...(overrides.authType === undefined
        ? {}
        : { auth: overrides.authType === null ? null : { type: overrides.authType } }),
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

function makeAgentBinding(contextRef: string, agents: Array<{ id: string; label: string }>) {
  return { contextRef, agents }
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

    expect(listedNames()).toEqual([
      'alpha-server',
      'bravo-server',
      'charlie-server',
      'zebra-server',
    ])
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Enabled ascending' }))
    expect(listedNames()).toEqual([
      'alpha-server',
      'charlie-server',
      'bravo-server',
      'zebra-server',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Status ascending' }))
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
    expect(within(row!).getByText('Search the public web.')).toHaveClass(
      'eft-truncated-text__value'
    )
  })

  it('truncates long connector descriptions with a hoverable full-value affordance', async () => {
    const longDescription =
      'Searches the public web with a long connector description that should be bounded in tables.'
    render(
      <McpServerTable items={[makeItem({ name: 'brave-search', description: longDescription })]} />
    )

    const description = screen.getByText(
      'Searches the public web with a long connector description that should be bounded...'
    )
    expect(description).toHaveClass('eft-truncated-text__value')
    fireEvent.mouseEnter(description)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(longDescription)
  })
})

describe('McpServerTable — connector list', () => {
  it('leaves authentication blank without a configured type and labels configured types', () => {
    render(
      <McpServerTable
        items={[
          makeItem({ name: 'public-connector' }),
          makeItem({ name: 'none-connector', authType: 'none' }),
          makeItem({ name: 'null-connector', authType: null }),
          makeItem({ name: 'oauth-connector', authType: 'oauth' }),
          makeItem({ name: 'static-connector', authType: 'bearer' }),
        ]}
      />
    )

    for (const name of ['public-connector', 'none-connector', 'null-connector']) {
      const row = screen.getByText(name).closest('tr')
      const authenticationCell = row?.querySelector('td:nth-child(3)')
      expect(authenticationCell?.textContent?.trim()).toBe('')
      expect(authenticationCell?.childElementCount).toBe(0)
    }
    expect(screen.getByText('oauth-connector').closest('tr')).toHaveTextContent('OAuth')
    expect(screen.getByText('static-connector').closest('tr')).toHaveTextContent(
      'Static credentials'
    )
    expect(screen.queryByText('No authentication')).toBeNull()
  })

  it('renders ordinary rows without inline detail expansion', () => {
    const items = [makeItem({ name: 'airtable-server' })]
    render(<McpServerTable items={items} />)

    expect(screen.getByText('airtable-server').closest('tr')).not.toHaveAttribute('aria-expanded')
    expect(screen.queryByRole('button', { name: /Expand connector/ })).toBeNull()
  })

  it('keeps access details and per-agent removal out of the list menu', () => {
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server' })]}
        agentBindingsByConnectorName={{
          'airtable-server': [
            makeAgentBinding('research', [{ id: 'agent-alpha', label: 'Agent Alpha' }]),
          ],
        }}
        onOpen={vi.fn()}
        onAddToAgents={vi.fn().mockResolvedValue(true)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    expect(screen.getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Add to agents' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'View access details' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Remove from Agent Alpha' })).toBeNull()
  })

  it('keeps connector endpoints searchable after removing the visible endpoint column', () => {
    const onOpen = vi.fn()
    render(<McpServerTable items={[makeItem({ name: 'airtable-server' })]} onOpen={onOpen} />)

    expect(screen.queryByRole('columnheader', { name: /Endpoint/i })).toBeNull()
    fireEvent.change(screen.getByLabelText('Search connectors'), {
      target: { value: 'brave-search.mcp-server' },
    })
    expect(screen.getByText('airtable-server')).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows the compact connector columns and omits removed metadata columns', () => {
    const image =
      'us-central1-docker.pkg.dev/example-project/example/nginx-egress-proxy:sha-3cbdf33'
    const url = 'http://brave-search.mcp-server.svc.cluster.local:3000/mcp'
    render(<McpServerTable items={[makeItem({ name: 'airtable-server', image })]} />)

    expect(screen.queryByRole('columnheader', { name: /Endpoint/i })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: /Image/i })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: /Transport/i })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: /Access/i })).toBeNull()
    expect(screen.getByRole('columnheader', { name: /Authentication/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Managed/i })).toBeInTheDocument()
    expect(screen.queryByTitle(url)).toBeNull()
    expect(screen.queryByTitle(image)).toBeNull()
  })

  it('filters rows by agent access labels', () => {
    const items = [
      makeItem({ name: 'airtable-server' }),
      makeItem({ name: 'search-server', contextRef: 'context2' }),
    ]
    render(
      <McpServerTable
        items={items}
        agentBindingsByConnectorName={{
          'airtable-server': [
            makeAgentBinding('context1', [{ id: 'agent-alpha', label: 'Agent Alpha' }]),
          ],
          'search-server': [
            makeAgentBinding('context2', [{ id: 'agent-beta', label: 'Agent Beta' }]),
          ],
        }}
      />
    )

    const search = screen.getByLabelText('Search connectors') as HTMLInputElement

    fireEvent.change(search, { target: { value: 'Agent Alpha' } })
    expect(screen.getByText('airtable-server')).toBeInTheDocument()
    expect(screen.queryByText('search-server')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'Agent Beta' } })
    expect(screen.queryByText('airtable-server')).not.toBeInTheDocument()
    expect(screen.getByText('search-server')).toBeInTheDocument()
  })
})

describe('McpServerTable — agent membership', () => {
  it('uses the agent selection modal to add the connector to more agents', async () => {
    const onAddToAgents = vi.fn().mockResolvedValue(true)
    const items = [makeItem({ name: 'airtable-server' })]
    render(
      <McpServerTable
        items={items}
        agentBindingsByConnectorName={{
          'airtable-server': [
            makeAgentBinding('research', [{ id: 'agent-alpha', label: 'Agent Alpha' }]),
          ],
        }}
        agentTargets={[
          { name: 'agent-alpha', label: 'Agent Alpha', contextRef: 'research' },
          { name: 'sales', label: 'Sales', contextRef: 'sales-context' },
        ]}
        onAddToAgents={onAddToAgents}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to agents' }))

    const dialog = screen.getByRole('dialog', { name: 'Give agents access to this connector' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.parentElement).toHaveClass('eft-dialog-backdrop')
    expect(screen.getByRole('searchbox', { name: 'Search agents' })).toBeInTheDocument()
    expect(screen.queryByText('No other agents available.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /Sales/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to agent' }))

    await waitFor(() =>
      expect(onAddToAgents).toHaveBeenCalledWith(
        { namespace: 'mcp-server', name: 'airtable-server' },
        [{ name: 'sales', contextRef: 'sales-context' }]
      )
    )
  })

  it('retains the selected agent and dialog error when connector access fails', async () => {
    const onAddToAgents = vi.fn().mockResolvedValue(false)
    render(
      <McpServerTable
        items={[makeItem({ name: 'airtable-server' })]}
        agentTargets={[{ name: 'sales', label: 'Sales', contextRef: 'sales-context' }]}
        onAddToAgents={onAddToAgents}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for connector airtable-server' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to agents' }))
    const dialog = screen.getByRole('dialog', { name: 'Give agents access to this connector' })
    const sales = within(dialog).getByRole('checkbox', { name: /Sales/ })
    fireEvent.click(sales)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to agent' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Connector access could not be updated'
    )
    expect(sales).toBeChecked()
    expect(dialog).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Row actions kebab
// ─────────────────────────────────────────────────────────────────────────────
describe('McpServerTable — row actions kebab', () => {
  it('exposes Edit and Remove via a single kebab menu per row and routes the click to the matching handler', async () => {
    const onOpen = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const items = [makeItem({ name: 'airtable-server' })]

    render(<McpServerTable items={items} onOpen={onOpen} onDelete={onDelete} />)

    const trigger = screen.getByRole('button', { name: 'Actions for connector airtable-server' })
    fireEvent.click(trigger)

    const editItem = await screen.findByRole('menuitem', { name: 'View details' })
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteItem).toHaveClass('eft-row-actions__item--danger')

    fireEvent.click(editItem)
    expect(onOpen).toHaveBeenCalledWith({ namespace: 'mcp-server', name: 'airtable-server' })
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
        onOpen={vi.fn()}
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
})

// ─────────────────────────────────────────────────────────────────────────────
// Header actions
// ─────────────────────────────────────────────────────────────────────────────
describe('McpServerTable — header actions', () => {
  function renderWithActions(options: { loading?: boolean; empty?: boolean } = {}) {
    const onCreate = vi.fn()
    const onAddRemote = vi.fn()
    const onInstallFromRegistry = vi.fn()
    render(
      <McpServerTable
        items={options.empty ? [] : [makeItem({})]}
        loading={options.loading}
        onCreate={onCreate}
        onAddRemote={onAddRemote}
        onInstallFromRegistry={onInstallFromRegistry}
      />
    )
    return { onCreate, onAddRemote, onInstallFromRegistry }
  }

  it('puts secondary actions in a menu and keeps Marketplace as the primary action', () => {
    const { onCreate, onAddRemote, onInstallFromRegistry } = renderWithActions()
    const trigger = screen.getByRole('button', { name: 'Connector actions' })
    const marketplace = screen.getByRole('button', { name: 'Marketplace' })

    expect(marketplace).toHaveClass('cu-btn--primary')
    expect(screen.queryByRole('button', { name: 'Create connector' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add remote server' })).not.toBeInTheDocument()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create connector' }))
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add remote server' }))
    fireEvent.click(marketplace)

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onAddRemote).toHaveBeenCalledTimes(1)
    expect(onInstallFromRegistry).toHaveBeenCalledTimes(1)
  })

  it('disables every header action during the initial load', () => {
    renderWithActions({ loading: true, empty: true })

    expect(screen.getByRole('button', { name: 'Marketplace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Connector actions' })).toBeDisabled()
  })

  it('omits a submenu item whose handler is not provided', () => {
    render(<McpServerTable items={[makeItem({})]} onAddRemote={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Connector actions' }))
    expect(screen.getByRole('menuitem', { name: 'Add remote server' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Create connector' })).not.toBeInTheDocument()
  })
})
