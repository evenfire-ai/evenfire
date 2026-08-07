import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HostTable } from '../HostTable'
import type { HostItem } from '../HostTable.types'

function makeHost(overrides: {
  name: string
  stateless?: boolean
  state?: string
  reason?: string
  rejectedMessage?: string
}): HostItem {
  return {
    metadata: { name: overrides.name, namespace: 'mcp-host' },
    spec: {
      contextRef: 'context1',
      lifecycle: overrides.stateless ? { stateless: true } : undefined,
      model: { provider: 'zai', name: 'glm-5.1' },
    },
    status: {
      lifecycle: overrides.state
        ? { state: overrides.state, reason: overrides.reason || '' }
        : undefined,
      conditions: overrides.rejectedMessage
        ? [
            {
              type: 'StatelessEnableRejected',
              status: 'True',
              message: overrides.rejectedMessage,
            },
          ]
        : undefined,
    },
  }
}

function renderHostTable(items: HostItem[]) {
  return render(
    <HostTable
      items={items}
      onOpen={vi.fn()}
      onOpenContext={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      deletingKey={null}
      onRefresh={vi.fn()}
      onCreateHost={vi.fn()}
      refreshing={false}
    />
  )
}

describe('HostTable lifecycle column', () => {
  it('renders stateful, stateless, and stateless-blocked lifecycle badges', () => {
    renderHostTable([
      makeHost({ name: 'chatllm' }),
      makeHost({ name: 'chatllm-stateless', stateless: true, state: 'suspended', reason: 'idle' }),
      makeHost({
        name: 'channel-host',
        stateless: true,
        state: 'active',
        rejectedMessage: 'CommunicationChannel-connected hosts are always-on.',
      }),
    ])

    expect(screen.getByLabelText('Stateful agent')).toBeInTheDocument()
    expect(screen.getByLabelText('Stateless: suspended - idle')).toBeInTheDocument()
    expect(
      screen.getByLabelText(
        'Stateless: blocked - CommunicationChannel-connected hosts are always-on.'
      )
    ).toBeInTheDocument()

    const blockedRow = screen.getByLabelText('Open agent channel-host')
    expect(within(blockedRow).getByText('blocked')).toBeInTheDocument()
  })

  it('filters rows by lifecycle reason text', () => {
    renderHostTable([
      makeHost({ name: 'chatllm', stateless: true, state: 'active', reason: 'recentActivity' }),
      makeHost({ name: 'chatllm-stateless', stateless: true, state: 'suspended', reason: 'idle' }),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), {
      target: { value: 'idle' },
    })

    expect(screen.queryByLabelText('Open agent chatllm')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Open agent chatllm-stateless')).toBeInTheDocument()
  })
})

// UT-9 — the row shows the editable display name (spec.host) as the primary
// label, with the immutable identifier (metadata.name / slug) as visible
// secondary text; the search haystack matches BOTH.
describe('HostTable display name column (UT-9)', () => {
  function makeDisplayHost(name: string, displayName: string): HostItem {
    return {
      metadata: { name, namespace: 'mcp-host' },
      spec: {
        host: displayName,
        contextRef: 'context1',
        model: { provider: 'zai', name: 'glm-5.1' },
      },
    }
  }

  it('renders the display name as primary and the slug as secondary', () => {
    renderHostTable([makeDisplayHost('prod-x', 'Prod X')])

    const row = screen.getByLabelText('Open agent prod-x')
    expect(within(row).getByText('Prod X')).toBeInTheDocument()
    expect(within(row).getByText('prod-x')).toBeInTheDocument()
  })

  it('filters rows by the display name', () => {
    renderHostTable([
      makeDisplayHost('prod-x', 'Prod X'),
      makeDisplayHost('sales-agent', 'Sales Agent'),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), {
      target: { value: 'Prod' },
    })

    expect(screen.getByText('Prod X')).toBeInTheDocument()
    expect(screen.queryByText('Sales Agent')).not.toBeInTheDocument()
  })

  it('filters rows by the slug identifier', () => {
    renderHostTable([
      makeDisplayHost('prod-x', 'Prod X'),
      makeDisplayHost('sales-agent', 'Sales Agent'),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), {
      target: { value: 'sales-agent' },
    })

    expect(screen.getByText('Sales Agent')).toBeInTheDocument()
    expect(screen.queryByText('Prod X')).not.toBeInTheDocument()
  })
})
