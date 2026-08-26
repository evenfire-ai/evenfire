// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import type { RpcConnectorsResult } from '../../../../src/types'
import { desktopQueryKeys } from '../../hooks/domain/queryKeys'
import { McpServersPage } from '../McpServersPage'

/**
 * T1: the fixture is typed as `RpcConnectorsResult` — the exact contract the IPC
 * bridge resolves from rpc-proxy's `GET /api/v1/rpc/connectors` (U1). The
 * compiler rejects any field the producer would not emit, and the U1 layer has
 * its own real-producer (Postgres + upsertOAuthGrant) integration tests.
 * T4: assertions are on the OBSERVABLE chip label + action the user sees.
 */
const CONNECTORS: RpcConnectorsResult = {
  userId: 'user-1',
  agents: [
    {
      name: 'agent-alpha',
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

describe('McpServersPage — tri-state chip + actionability (T5#3, T4)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('distinguishes the 3 statuses and only authorized/requires_setup are actionable', async () => {
    installClerum(CONNECTORS)
    const { container } = renderPage(CONNECTORS)

    // The agent group renders once the query resolves.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'agent-alpha' })).toBeTruthy())

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.da-grid__body .da-grid__row'))
    // One row per connector in the fixture.
    expect(rows).toHaveLength(4)

    const rowByFirstCellText = (needle: string) => {
      const row = rows.find(r => (r.textContent ?? '').includes(needle))
      if (!row) throw new Error(`row not found for ${needle}`)
      return row
    }
    const chipText = (row: HTMLElement) =>
      row.querySelector('.ui-pill')?.textContent?.trim() ?? null
    const buttonNames = (row: HTMLElement) =>
      within(row)
        .queryAllByRole('button')
        .map(b => b.textContent?.trim())

    // authorized → "Authorized" chip + Disconnect only.
    const authorizedRow = rowByFirstCellText('monday')
    expect(chipText(authorizedRow)).toBe('Authorized')
    expect(buttonNames(authorizedRow)).toEqual(['Disconnect'])

    // requires_setup (oauth-user) → "Requires setup" chip + Authorize only.
    const requiresRow = rowByFirstCellText('clickup')
    expect(chipText(requiresRow)).toBe('Requires setup')
    expect(buttonNames(requiresRow)).toEqual(['Authorize'])

    // no_oauth → "No OAuth" chip + NO action button (not actionable on this rail).
    const noOauthRow = rowByFirstCellText('filesystem')
    expect(chipText(noOauthRow)).toBe('No OAuth')
    expect(buttonNames(noOauthRow)).toEqual([])

    // oauth-context requires_setup → actionable AND flagged as shared/team-wide.
    const sharedRow = rowByFirstCellText('shared-drive')
    expect(chipText(sharedRow)).toBe('Requires setup')
    expect(buttonNames(sharedRow)).toEqual(['Authorize'])
    expect(within(sharedRow).getByText(/Shared by the team/i)).toBeTruthy()
  })
})
