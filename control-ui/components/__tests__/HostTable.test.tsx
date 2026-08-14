import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HostTable, collectProviderIds } from '../HostTable'
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

// Pure-function invariants for collectProviderIds — exported so the ordering
// and deduplication contract is verifiable independently of the DOM.
describe('collectProviderIds (HostTable provider extraction)', () => {
  it('returns just the primary provider when no fallbacks are configured', () => {
    expect(collectProviderIds({ model: { provider: 'openai' } })).toEqual(['openai'])
  })

  it('returns primary first then fallbacks in declared order', () => {
    expect(
      collectProviderIds({
        model: { provider: 'openai' },
        llmPolicy: { fallbacks: [{ provider: 'claude' }, { provider: 'zai' }] },
      })
    ).toEqual(['openai', 'claude', 'zai'])
  })

  it('deduplicates when the primary provider is also listed as a fallback', () => {
    expect(
      collectProviderIds({
        model: { provider: 'openai' },
        llmPolicy: { fallbacks: [{ provider: 'openai' }, { provider: 'zai' }] },
      })
    ).toEqual(['openai', 'zai'])
  })

  it('deduplicates when the same fallback provider appears twice', () => {
    expect(
      collectProviderIds({
        model: { provider: 'openai' },
        llmPolicy: { fallbacks: [{ provider: 'claude' }, { provider: 'claude' }] },
      })
    ).toEqual(['openai', 'claude'])
  })

  it('drops empty fallback entries', () => {
    expect(
      collectProviderIds({
        model: { provider: 'openai' },
        llmPolicy: { fallbacks: [{ provider: '' }, { provider: '  ' }, { provider: 'zai' }] },
      })
    ).toEqual(['openai', 'zai'])
  })

  it('returns an empty list when neither model nor fallbacks are present', () => {
    expect(collectProviderIds({})).toEqual([])
    expect(collectProviderIds({ model: {} })).toEqual([])
    expect(collectProviderIds({ llmPolicy: { fallbacks: [] } })).toEqual([])
  })

  it('preserves fallback order even when the primary duplicates an earlier fallback', () => {
    expect(
      collectProviderIds({
        model: { provider: 'zai' },
        llmPolicy: { fallbacks: [{ provider: 'claude' }, { provider: 'zai' }] },
      })
    ).toEqual(['zai', 'claude'])
  })
})

// Rendered coverage: the cell exposes the collected provider ids through
// aria-label, and renders one chip per unique provider in order. These
// assertions bind the cell's DOM contract to the helper's output.
describe('HostTable providers column rendering', () => {
  function chipTitles(cell: HTMLElement): string[] {
    return Array.from(cell.querySelectorAll<HTMLElement>('.cu-host-providers__chip')).map(
      chip => chip.getAttribute('title') || ''
    )
  }

  function providersCell(row: HTMLElement): HTMLElement {
    return within(row).getByLabelText(/^Providers:/)
  }

  function hostWithModel(
    name: string,
    model: Record<string, unknown>,
    fallbacks?: Array<{ provider?: string }>
  ): HostItem {
    return {
      metadata: { name, namespace: 'mcp-host' },
      spec: {
        contextRef: 'context1',
        model: model as { provider?: string; name?: string },
        llmPolicy: fallbacks ? ({ fallbacks } as Record<string, unknown>) : undefined,
      },
    }
  }

  it('renders one icon per unique provider in primary-then-fallback order', () => {
    renderHostTable([
      hostWithModel('chatllm', { provider: 'openai' }, [
        { provider: 'claude' },
        { provider: 'zai' },
      ]),
    ])

    const row = screen.getByLabelText('Open agent chatllm')
    const cell = providersCell(row)

    // aria-label lists every collected label in order.
    expect(cell).toHaveAttribute('aria-label', 'Providers: OpenAI, Anthropic, Z.AI')

    // Each chip exposes its label as the native title (hover tooltip).
    expect(chipTitles(cell)).toEqual(['OpenAI', 'Anthropic', 'Z.AI'])
  })

  it('renders a single icon when a fallback duplicates the primary', () => {
    renderHostTable([
      hostWithModel('chatllm', { provider: 'openai' }, [
        { provider: 'openai' },
        { provider: 'zai' },
      ]),
    ])

    const row = screen.getByLabelText('Open agent chatllm')
    const cell = providersCell(row)
    expect(cell).toHaveAttribute('aria-label', 'Providers: OpenAI, Z.AI')
    expect(chipTitles(cell)).toEqual(['OpenAI', 'Z.AI'])
  })

  it('renders no chips when the host has no provider', () => {
    renderHostTable([
      {
        metadata: { name: 'providerless' },
        spec: { contextRef: 'context1' },
      },
    ])

    const row = screen.getByLabelText('Open agent providerless')
    expect(within(row).queryByLabelText(/^Providers:/)).not.toBeInTheDocument()
    expect(within(row).getByText('-')).toBeInTheDocument()
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

  it('falls back to the slug as the primary label when spec.host is blank', () => {
    renderHostTable([makeDisplayHost('prod-x', '   ')])

    const row = screen.getByLabelText('Open agent prod-x')
    // Only the slug renders — no separate secondary line duplicating it.
    expect(within(row).getAllByText('prod-x')).toHaveLength(1)
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
