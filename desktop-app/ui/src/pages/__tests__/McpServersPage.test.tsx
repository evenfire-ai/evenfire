// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AccessCatalog, RpcConnectorsResult } from '../../../../src/types'
import { desktopQueryKeys } from '../../hooks/domain/queryKeys'
import { McpServersPage } from '../McpServersPage'

// Capture the navigation handlers the page deep-links through. Hoisted so the
// vi.mock factory can reference it.
const navMock = vi.hoisted(() => ({
  handleOpenAgentWorkspace: vi.fn(),
}))
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigationContext: () => navMock,
}))

/**
 * T1: the fixture is typed as `RpcConnectorsResult` — the exact contract the IPC
 * bridge resolves from rpc-proxy's `GET /api/v1/rpc/connectors` (U1). The
 * payload is grouped BY AGENT; the page explodes it to one row per
 * `(connector, agent)` (spec §5.E). Fixture exercises a grant shared by two
 * agents (two rows, one grantKey), a contextless `oauth-user` connector, and the
 * tri-state chip + actionability.
 */
const CONNECTORS: RpcConnectorsResult = {
  userId: 'user-1',
  agents: [
    {
      name: 'agent-zeta',
      contextRef: 'ctx-team',
      connectors: [
        {
          name: 'monday',
          provider: 'monday',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'authorized',
        },
        {
          name: 'clickup',
          provider: 'clickup',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'requires_setup',
        },
        { name: 'filesystem', authKind: 'static', status: 'no_oauth' },
        {
          name: 'shared-drive',
          provider: 'google',
          authKind: 'oauth-context',
          grantScope: 'context',
          status: 'requires_setup',
        },
      ],
    },
    {
      name: 'agent-alpha',
      contextRef: 'ctx-team',
      connectors: [
        // Same context + server as agent-zeta's monday → SAME grant, but the
        // agent-centric list shows a SEPARATE per-agent row. Each row deep-links
        // to its own agent and acts under its own agent.
        {
          name: 'monday',
          provider: 'monday',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'authorized',
        },
      ],
    },
    {
      name: 'agent-orphan',
      contextRef: null,
      connectors: [
        {
          name: 'loner',
          provider: 'loner',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'requires_setup',
        },
      ],
    },
  ],
}

function installClerum(result: RpcConnectorsResult) {
  const rpc = {
    listConnectors: vi.fn(async () => result),
    connectMcpServer: vi.fn(async () => undefined),
    disconnectMcpServer: vi.fn(async () => ({ confirmed: true })),
  }
  Object.defineProperty(window, 'clerum', { configurable: true, value: { rpc } })
  return rpc
}

function renderPage(result: RpcConnectorsResult) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // The controller's query is `enabled:false` — the app coordinator owns the
  // initial load, so a navigation to the panel only READS cache. Seed the cache
  // the way the post-auth bootstrap would, then render.
  client.setQueryData(desktopQueryKeys.connectors, result)
  return render(
    <QueryClientProvider client={client}>
      <McpServersPage />
    </QueryClientProvider>
  )
}

const allRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.mcp-servers-data-table tbody tr'))
const rowName = (row: HTMLElement) =>
  row.querySelector('.context-id-cell')?.textContent?.trim() ?? ''
const agentTag = (row: HTMLElement) =>
  row.querySelector('.reference-tag--agent .reference-tag__label')?.textContent?.trim() ?? null
const chipText = (row: HTMLElement) => row.querySelector('.ui-pill')?.textContent?.trim() ?? null
// One row per (connector, agent): identify by BOTH so the two `monday` sibling
// rows are addressable independently.
const rowBy = (rows: HTMLElement[], name: string, agent: string) => {
  const row = rows.find(r => rowName(r).startsWith(name) && agentTag(r) === agent)
  if (!row) throw new Error(`row not found for ${name} / ${agent}`)
  return row
}

describe('McpServersPage — da-table layout + navigation', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('(a) a shared grant renders one row per agent, each deep-linking to ITS agent', async () => {
    installClerum(CONNECTORS)
    const { container } = renderPage(CONNECTORS)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connectors' })).toBeTruthy())

    const rows = allRows(container)
    // monday is granted to agent-alpha AND agent-zeta → TWO rows, one per agent.
    const alphaRow = rowBy(rows, 'monday', 'agent-alpha')
    const zetaRow = rowBy(rows, 'monday', 'agent-zeta')

    fireEvent.click(alphaRow)
    expect(navMock.handleOpenAgentWorkspace).toHaveBeenLastCalledWith('agent-alpha', 'mcp-servers')

    fireEvent.click(zetaRow)
    expect(navMock.handleOpenAgentWorkspace).toHaveBeenLastCalledWith('agent-zeta', 'mcp-servers')
    expect(navMock.handleOpenAgentWorkspace).toHaveBeenCalledTimes(2)
  })

  it('(b) mouse OR keyboard on Authorize/Disconnect fires the action WITHOUT navigating', () => {
    const rpc = installClerum(CONNECTORS)
    const { container } = renderPage(CONNECTORS)
    const rows = allRows(container)

    // Disconnect on agent-alpha's authorized monday row: acts under agent-alpha
    // (the row's OWN agent) and does NOT trigger the row navigation.
    const alphaMonday = rowBy(rows, 'monday', 'agent-alpha')
    const disconnectBtn = within(alphaMonday).getByRole('button', { name: 'Disconnect' })
    fireEvent.click(disconnectBtn)
    expect(rpc.disconnectMcpServer).toHaveBeenCalledWith('monday', 'agent-alpha', undefined, {
      shared: false,
    })
    expect(navMock.handleOpenAgentWorkspace).not.toHaveBeenCalled()

    // Keyboard regression: Enter/Space on the button must NOT bubble to the
    // row's clickableRowProps onKeyDown and navigate.
    fireEvent.keyDown(disconnectBtn, { key: 'Enter' })
    fireEvent.keyDown(disconnectBtn, { key: ' ' })
    expect(navMock.handleOpenAgentWorkspace).not.toHaveBeenCalled()

    // Authorize on the requires_setup clickup row (agent-zeta) → acts under agent-zeta.
    const clickupRow = rowBy(rows, 'clickup', 'agent-zeta')
    const authorizeBtn = within(clickupRow).getByRole('button', { name: 'Authorize' })
    fireEvent.click(authorizeBtn)
    expect(rpc.connectMcpServer).toHaveBeenCalledWith('clickup', 'agent-zeta', undefined, {
      confirmShared: false,
    })
    fireEvent.keyDown(authorizeBtn, { key: 'Enter' })
    expect(navMock.handleOpenAgentWorkspace).not.toHaveBeenCalled()
  })

  it('(c) the Agent cell is presentational — no nested interactive control of its own', () => {
    installClerum(CONNECTORS)
    const { container } = renderPage(CONNECTORS)

    const alphaMonday = rowBy(allRows(container), 'monday', 'agent-alpha')
    // The agent tag renders as a plain (non-button) tag: the row already
    // navigates to that agent, so the tag carries no click/key handlers.
    const tag = alphaMonday.querySelector('.reference-tag--agent')
    expect(tag).not.toBeNull()
    expect(tag?.tagName.toLowerCase()).toBe('span')
    // The only actionable button in an authorized row is Disconnect.
    const buttons = within(alphaMonday)
      .queryAllByRole('button')
      .map(b => b.textContent?.trim())
      .filter(label => label === 'Authorize' || label === 'Disconnect')
    expect(buttons).toEqual(['Disconnect'])
  })

  it('(d) a contextless (oauth-user) row is clickable and deep-links to its agent', () => {
    installClerum(CONNECTORS)
    const { container } = renderPage(CONNECTORS)

    const lonerRow = rowBy(allRows(container), 'loner', 'agent-orphan')
    // Row-level button semantics ARE present now — every row navigates.
    expect(lonerRow.getAttribute('role')).toBe('button')
    fireEvent.click(lonerRow)
    expect(navMock.handleOpenAgentWorkspace).toHaveBeenCalledWith('agent-orphan', 'mcp-servers')
  })

  it('(e) distinguishes the 3 statuses and only authorized/requires_setup are actionable', () => {
    installClerum(CONNECTORS)
    const { container } = renderPage(CONNECTORS)
    const rows = allRows(container)

    const buttonLabels = (row: HTMLElement) =>
      within(row)
        .queryAllByRole('button')
        // Drop the row-surface button (its label starts with "Open connectors").
        .map(b => b.textContent?.trim())
        .filter(label => label === 'Authorize' || label === 'Disconnect')

    const monday = rowBy(rows, 'monday', 'agent-zeta')
    expect(chipText(monday)).toBe('Authorized')
    expect(buttonLabels(monday)).toEqual(['Disconnect'])

    const clickup = rowBy(rows, 'clickup', 'agent-zeta')
    expect(chipText(clickup)).toBe('Requires setup')
    expect(buttonLabels(clickup)).toEqual(['Authorize'])

    const filesystem = rowBy(rows, 'filesystem', 'agent-zeta')
    expect(chipText(filesystem)).toBe('No OAuth')
    expect(buttonLabels(filesystem)).toEqual([])

    // oauth-user status pill surfaces the blast-radius caption as a tooltip.
    expect(monday.querySelector('.ui-pill')?.getAttribute('title')).toMatch(
      /Affects all your agents/i
    )
  })

  it('(f) shows agent DISPLAY names from the catalog map, not the raw host id (R1-M12)', async () => {
    installClerum(CONNECTORS)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Seed both the connectors read-model and the access catalog the way the
    // bootstrap would; the catalog carries host→display, exactly as AppHeader /
    // ContextDetailsPage / TeamsPage resolve visible agent names.
    client.setQueryData(desktopQueryKeys.connectors, CONNECTORS)
    client.setQueryData(desktopQueryKeys.accessCatalog, {
      agentDisplayByName: { 'agent-alpha': 'Alpha Bot', 'agent-zeta': 'Zeta Bot' },
    } as unknown as AccessCatalog)
    const { container } = render(
      <QueryClientProvider client={client}>
        <McpServersPage />
      </QueryClientProvider>
    )
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connectors' })).toBeTruthy())

    // monday is granted to agent-alpha AND agent-zeta → TWO per-agent rows. Each
    // row's presentational agent tag shows the catalog DISPLAY name, and the raw
    // host id is no longer surfaced there.
    const mondayTags = allRows(container)
      .filter(row => rowName(row).startsWith('monday'))
      .map(agentTag)
    expect(mondayTags).toContain('Alpha Bot')
    expect(mondayTags).toContain('Zeta Bot')
    expect(mondayTags).not.toContain('agent-alpha')
    expect(mondayTags).not.toContain('agent-zeta')
  })

  it('(g) a fresh write error takes precedence over a stale read error in the banner', async () => {
    // Reviewer follow-up nit: with a failed READ (query error) and a failed WRITE
    // (actionError) both live, the banner must show the MORE RECENT event — the
    // write. Old render was `error ? … : actionError`, which pinned the stale read
    // on top. Repro: 1st disconnect is confirmed → triggers a refresh whose read
    // throws (sets query.error); 2nd disconnect rejects (sets actionError).
    const rpc = {
      listConnectors: vi.fn(async () => {
        throw new Error('read boom')
      }),
      connectMcpServer: vi.fn(async () => undefined),
      disconnectMcpServer: vi
        .fn()
        .mockResolvedValueOnce({ confirmed: true }) // 1st: confirmed → refresh (read fails)
        .mockRejectedValueOnce(new Error('write boom')), // 2nd: rejects → actionError
    }
    Object.defineProperty(window, 'clerum', { configurable: true, value: { rpc } })

    const { container } = renderPage(CONNECTORS)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connectors' })).toBeTruthy())

    // Either monday row acts on the same grant; use agent-zeta's authorized row.
    const mondayRow = rowBy(allRows(container), 'monday', 'agent-zeta')
    const disconnectBtn = within(mondayRow).getByRole('button', { name: 'Disconnect' })

    // 1st disconnect: confirmed → refresh → listConnectors throws → query.error set.
    fireEvent.click(disconnectBtn)
    await waitFor(() => expect(screen.getByText('read boom')).toBeTruthy())

    // 2nd disconnect: rejects → actionError set. Both errors now live; the fresh
    // write message must win, and the stale read message must be gone.
    fireEvent.click(disconnectBtn)
    await waitFor(() =>
      expect(screen.getByText('Couldn\'t disconnect "monday". write boom')).toBeTruthy()
    )
    expect(screen.queryByText('read boom')).toBeNull()
  })
})
