import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HostTable, collectProviderIds } from '../HostTable'
import type { HostItem } from '../HostTable.types'

function renderHostTable(items: HostItem[], contextsByRef?: Record<string, string[]>) {
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
      contextsByRef={contextsByRef}
    />
  )
}

function hostWithContext(
  name: string,
  contextRef: string,
  model?: Record<string, unknown>
): HostItem {
  return {
    metadata: { name, namespace: 'mcp-host' },
    spec: {
      contextRef,
      ...(model ? { model: model as { provider?: string; name?: string } } : {}),
    },
  }
}

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

// Hover card on the Context column — when the page supplies a `contextsByRef`
// map, hovering (or keyboard-focusing) the context link reveals the same
// MCP-server list the create wizard shows for the selected context.
describe('HostTable context MCP hover card', () => {
  function contextLink(row: HTMLElement): HTMLElement {
    return within(row).getByRole('button', { name: 'context1' })
  }

  it('reveals the MCP server list on hover and lists every server', () => {
    renderHostTable([hostWithContext('chatllm', 'context1')], {
      context1: ['github', 'linear', 'slack'],
    })

    const row = screen.getByLabelText('Open agent chatllm')
    const link = contextLink(row)

    // Closed by default — nothing tooltipped.
    expect(within(row).queryByRole('tooltip')).not.toBeInTheDocument()
    expect(link).not.toHaveAttribute('aria-describedby')

    fireEvent.mouseEnter(link)
    const card = within(row).getByRole('tooltip')
    expect(card).toHaveTextContent('MCP servers')
    expect(card).toHaveTextContent('3')
    expect(within(card).getByText('github')).toBeInTheDocument()
    expect(within(card).getByText('linear')).toBeInTheDocument()
    expect(within(card).getByText('slack')).toBeInTheDocument()

    fireEvent.mouseLeave(link)
    expect(within(row).queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('reveals the card on keyboard focus (accessible path)', () => {
    renderHostTable([hostWithContext('chatllm', 'context1')], {
      context1: ['github'],
    })

    const row = screen.getByLabelText('Open agent chatllm')
    const link = contextLink(row)

    fireEvent.focus(link)
    const card = within(row).getByRole('tooltip')
    expect(within(card).getByText('github')).toBeInTheDocument()
    expect(link).toHaveAttribute('aria-describedby', card.id)

    fireEvent.blur(link)
    expect(within(row).queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stays a plain link when the context has no MCP servers', () => {
    renderHostTable([hostWithContext('chatllm', 'context1')], {
      context1: [],
    })

    const row = screen.getByLabelText('Open agent chatllm')
    expect(within(row).queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(within(row).getByRole('button', { name: 'context1' }))
    expect(within(row).queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('does not show a card when the context map is missing', () => {
    renderHostTable([hostWithContext('chatllm', 'context1')])

    const row = screen.getByLabelText('Open agent chatllm')
    const link = within(row).getByRole('button', { name: 'context1' })
    fireEvent.mouseEnter(link)
    expect(within(row).queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Row actions kebab
// ─────────────────────────────────────────────────────────────────────────────
describe('HostTable — row actions kebab', () => {
  it('exposes View agent details and Delete via a single kebab menu per row', () => {
    const onOpen = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <HostTable
        items={[hostWithContext('chatllm', 'context1')]}
        onOpen={onOpen}
        onOpenContext={vi.fn()}
        onDelete={onDelete}
        deletingKey={null}
        onRefresh={vi.fn()}
        onCreateHost={vi.fn()}
        refreshing={false}
        contextsByRef={{ context1: [] }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for agent chatllm' }))

    const viewItem = screen.getByRole('menuitem', { name: 'View agent details' })
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteItem).toHaveClass('cu-kebab__item--danger')

    fireEvent.click(viewItem)
    expect(onOpen).toHaveBeenCalledWith({ namespace: 'mcp-host', name: 'chatllm' })
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('does not open the agent detail when clicking the kebab itself', () => {
    const onOpen = vi.fn()
    render(
      <HostTable
        items={[hostWithContext('chatllm', 'context1')]}
        onOpen={onOpen}
        onOpenContext={vi.fn()}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        deletingKey={null}
        onRefresh={vi.fn()}
        onCreateHost={vi.fn()}
        refreshing={false}
        contextsByRef={{ context1: [] }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for agent chatllm' }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('disables only the Delete item while deleting and renames it to Deleting agent…', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <HostTable
        items={[hostWithContext('chatllm', 'context1')]}
        onOpen={vi.fn()}
        onOpenContext={vi.fn()}
        onDelete={onDelete}
        deletingKey="mcp-host/chatllm"
        onRefresh={vi.fn()}
        onCreateHost={vi.fn()}
        refreshing={false}
        contextsByRef={{ context1: [] }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for agent chatllm' }))

    const viewItem = screen.getByRole('menuitem', { name: 'View agent details' })
    const deletingItem = screen.getByRole('menuitem', { name: 'Deleting agent…' })

    expect(viewItem).not.toBeDisabled()
    expect(deletingItem).toBeDisabled()
  })
})
