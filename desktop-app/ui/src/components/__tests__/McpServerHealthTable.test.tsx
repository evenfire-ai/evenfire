// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MCP_INIT_AUTH_FAILED_MESSAGE } from '../../../../src/mcpServerHealth'
import type { HostRuntimeStatus, McpServerHealthRow } from '../../../../src/types'
import { McpServerHealthTable } from '../McpServerHealthTable'

afterEach(cleanup)

const NOW = Date.parse('2026-04-21T18:00:00.000Z')

function row(overrides: Partial<McpServerHealthRow> & { name: string }): McpServerHealthRow {
  return {
    state: 'connected',
    expected: true,
    toolCount: 1,
    reason: null,
    message: null,
    observedAt: new Date(NOW - 1000).toISOString(),
    ...overrides,
  }
}

function status(mcpServers?: McpServerHealthRow[]): HostRuntimeStatus {
  return {
    hostRef: 'trader',
    agent: {
      state: 'idle',
      currentTaskId: null,
      tasksProcessed: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      uptime: 0,
    },
    queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
    cronJobs: 0,
    pendingApprovalsCount: 0,
    observedAt: new Date(NOW).toISOString(),
    ...(mcpServers ? { mcpServers } : {}),
  }
}

// Row-level assertions need the body visible. `defaultExpanded` pre-opens
// the section so the test doesn't simulate a click. Collapse semantics have
// their own dedicated describe block below.
const EXPANDED = { defaultExpanded: true } as const

describe('McpServerHealthTable — body (expanded)', () => {
  it('renders an empty state when the agent has no configured connectors', () => {
    render(
      <McpServerHealthTable hostRef="trader" mcpServerNames={[]} status={status([])} now={NOW} />
    )
    expect(screen.getByTestId('mcp-health-empty')).toBeTruthy()
  })

  it('renders Running for connected rows with toolCount > 0', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-alphavantage-remote']}
        status={status([
          row({ name: 'mcp-alphavantage-remote', state: 'connected', toolCount: 5 }),
        ])}
        now={NOW}
        {...EXPANDED}
      />
    )
    const rowEl = screen.getByTestId('mcp-health-row-mcp-alphavantage-remote')
    expect(rowEl.getAttribute('data-label')).toBe('running')
    expect(rowEl.textContent).toContain('alphavantage')
    expect(rowEl.textContent).toContain('Running')
  })

  it('renders Degraded for connected rows with toolCount === 0', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-empty']}
        status={status([row({ name: 'mcp-empty', state: 'connected', toolCount: 0 })])}
        now={NOW}
        {...EXPANDED}
      />
    )
    expect(screen.getByTestId('mcp-health-row-mcp-empty').getAttribute('data-label')).toBe(
      'degraded'
    )
  })

  it('renders Failed with the exact message for scenario #1 (CoinGecko 401)', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-coingecko-remote']}
        status={status([
          row({
            name: 'mcp-coingecko-remote',
            state: 'failed',
            reason: 'auth_failed',
            message: MCP_INIT_AUTH_FAILED_MESSAGE,
            toolCount: 0,
          }),
        ])}
        now={NOW}
        {...EXPANDED}
      />
    )
    const rowEl = screen.getByTestId('mcp-health-row-mcp-coingecko-remote')
    expect(rowEl.getAttribute('data-label')).toBe('failed')
    expect(rowEl.getAttribute('data-reason')).toBe('auth_failed')
    expect(rowEl.textContent).toContain('Failed')
  })

  it("shows the 'Awaiting live status' hint when the status omits mcpServers (old mcp-host)", () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a', 'mcp-b']}
        status={status()} // no mcpServers field
        now={NOW}
        {...EXPANDED}
      />
    )
    expect(screen.getByTestId('mcp-health-unknown-fallback')).toBeTruthy()
    expect(screen.getByTestId('mcp-health-row-mcp-a').getAttribute('data-label')).toBe('unknown')
    expect(screen.getByTestId('mcp-health-row-mcp-b').getAttribute('data-label')).toBe('unknown')
  })

  it('shows Unknown (no hosts status) when RPC status is entirely absent (null)', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={null}
        now={NOW}
        {...EXPANDED}
      />
    )
    expect(screen.getByTestId('mcp-health-row-mcp-a').getAttribute('data-label')).toBe('unknown')
    expect(screen.getByTestId('mcp-health-unknown-fallback')).toBeTruthy()
  })

  it('preserves the catalog order regardless of RPC row order', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a', 'mcp-b', 'mcp-c']}
        status={status([
          row({ name: 'mcp-c', state: 'connected', toolCount: 1 }),
          row({ name: 'mcp-a', state: 'connected', toolCount: 1 }),
          row({ name: 'mcp-b', state: 'connected', toolCount: 1 }),
        ])}
        now={NOW}
        {...EXPANDED}
      />
    )
    const rendered = screen
      .getAllByTestId(/mcp-health-row-/)
      .map(el => el.getAttribute('data-testid'))
    expect(rendered).toEqual([
      'mcp-health-row-mcp-a',
      'mcp-health-row-mcp-b',
      'mcp-health-row-mcp-c',
    ])
  })
})

describe('McpServerHealthTable — refresh button', () => {
  it('omits the refresh button when onRefresh is not provided', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={status([row({ name: 'mcp-a', state: 'connected', toolCount: 1 })])}
        now={NOW}
      />
    )
    expect(screen.queryByTestId('mcp-health-refresh')).toBeNull()
  })

  it('renders a refresh button and fires onRefresh when clicked', () => {
    const onRefresh = vi.fn()
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={status([row({ name: 'mcp-a', state: 'connected', toolCount: 1 })])}
        now={NOW}
        onRefresh={onRefresh}
      />
    )
    const btn = screen.getByTestId('mcp-health-refresh')
    fireEvent.click(btn)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables the refresh button while refreshing is true', () => {
    const onRefresh = vi.fn()
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={status([row({ name: 'mcp-a', state: 'connected', toolCount: 1 })])}
        now={NOW}
        onRefresh={onRefresh}
        refreshing
      />
    )
    const btn = screen.getByTestId('mcp-health-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('clicking the refresh button does not toggle the section (stopPropagation)', () => {
    const onRefresh = vi.fn()
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={status([row({ name: 'mcp-a', state: 'connected', toolCount: 1 })])}
        now={NOW}
        onRefresh={onRefresh}
      />
    )
    // Default is collapsed.
    expect(screen.getByTestId('mcp-health-table').getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByTestId('mcp-health-refresh'))
    expect(screen.getByTestId('mcp-health-table').getAttribute('data-expanded')).toBe('false')
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('still renders the refresh button in the empty-catalog state', () => {
    const onRefresh = vi.fn()
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={[]}
        status={status([])}
        now={NOW}
        onRefresh={onRefresh}
      />
    )
    expect(screen.getByTestId('mcp-health-empty')).toBeTruthy()
    expect(screen.getByTestId('mcp-health-refresh')).toBeTruthy()
  })
})

describe('McpServerHealthTable — collapse / expand', () => {
  function renderCollapsed() {
    return render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a', 'mcp-b', 'mcp-c']}
        status={status([
          row({ name: 'mcp-a', state: 'connected', toolCount: 1 }),
          row({
            name: 'mcp-b',
            state: 'failed',
            reason: 'auth_failed',
            message: 'initialize returned 401',
            toolCount: 0,
          }),
          row({ name: 'mcp-c', state: 'connected', toolCount: 0 }),
        ])}
        now={NOW}
      />
    )
  }

  it('defaults to collapsed — body is not in the DOM, summary shows count', () => {
    renderCollapsed()
    expect(screen.getByTestId('mcp-health-table').getAttribute('data-expanded')).toBe('false')
    expect(screen.queryByTestId('mcp-health-row-mcp-a')).toBeNull()
    expect(screen.getByTestId('mcp-health-summary').textContent).toContain('3 servers')
  })

  it('summary surfaces attention count when rows need attention (Failed / Degraded / Stale)', () => {
    renderCollapsed()
    const attention = screen.getByTestId('mcp-health-summary-attention')
    // mcp-b is failed, mcp-c is degraded (toolCount=0 + connected) → 2 need attention
    expect(attention.textContent).toMatch(/2 need/)
  })

  it('omits the attention chip when every row is Running', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={status([row({ name: 'mcp-a', state: 'connected', toolCount: 2 })])}
        now={NOW}
      />
    )
    expect(screen.queryByTestId('mcp-health-summary-attention')).toBeNull()
  })

  it('clicking the heading toggles the body', () => {
    renderCollapsed()
    const toggle = screen.getByTestId('mcp-health-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('mcp-health-row-mcp-a')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('mcp-health-row-mcp-a')).toBeNull()
  })

  it('respects defaultExpanded=true', () => {
    render(
      <McpServerHealthTable
        hostRef="trader"
        mcpServerNames={['mcp-a']}
        status={status([row({ name: 'mcp-a', state: 'connected', toolCount: 1 })])}
        now={NOW}
        defaultExpanded
      />
    )
    expect(screen.getByTestId('mcp-health-table').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('mcp-health-row-mcp-a')).toBeTruthy()
  })
})
