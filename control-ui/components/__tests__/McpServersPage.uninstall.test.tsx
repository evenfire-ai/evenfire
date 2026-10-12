import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import McpServersPage from '../../app/mcp-servers/page'
import * as api from '../../lib/api'
import {
  SECRETS_PENDING_BODY,
  uninstallIncompleteResponse,
} from '../../test/fixtures/mcpServerUninstall'

const showToast = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn().mockResolvedValue(true), confirmDialog: null }),
}))

vi.mock('../DashboardLayout', async () => {
  const React = await import('react')
  return {
    DashboardLayout: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
  }
})

vi.mock('../Toast', () => ({
  useToast: () => ({ showToast }),
}))

vi.mock('../McpServerTable', async () => {
  const React = await import('react')
  return {
    McpServerTable: (props: {
      items: Array<{ metadata: { name: string; namespace: string } }>
      deletingKey: string | null
      onDelete: (server: { name: string; namespace: string }) => Promise<void>
    }) =>
      React.createElement(
        'ul',
        null,
        props.items.map(item =>
          React.createElement(
            'li',
            { key: item.metadata.name },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: props.deletingKey !== null,
                onClick: () => props.onDelete(item.metadata),
              },
              `Delete ${item.metadata.name}`
            )
          )
        )
      ),
  }
})

// The page's delete goes through the real client (fetch stubbed below) so the
// typed error comes from parsing the producer's body, not from a hand-built object.
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getAgentTeams: vi.fn().mockResolvedValue({ items: [] }),
    getAgentUsers: vi.fn().mockResolvedValue({ items: [] }),
    getContexts: vi.fn().mockResolvedValue({ items: [] }),
    getHosts: vi.fn().mockResolvedValue({ items: [] }),
    getMcpServers: vi.fn(),
    updateContext: vi.fn().mockResolvedValue({}),
  }
})

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(api.getMcpServers).mockResolvedValue({
    items: [{ metadata: { name: 'srv', namespace: 'mcp-server' }, spec: {} }],
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Installed Connectors delete with an incomplete uninstall', () => {
  it('shows the pending cleanup, keeps the refreshed row, and lets the operator retry', async () => {
    fetchMock.mockResolvedValueOnce(uninstallIncompleteResponse(SECRETS_PENDING_BODY))
    render(<McpServersPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete srv' }))

    expect(
      await screen.findByText(
        'mcp-server/srv: Connector uninstall is incomplete (pending cleanup: connector Secrets). ' +
          'The connector is still installed; retry the delete to finish.'
      )
    ).toBeInTheDocument()
    expect(api.getMcpServers).toHaveBeenCalledTimes(2)
    expect(showToast).not.toHaveBeenCalled()
    const retry = screen.getByRole('button', { name: 'Delete srv' })
    await waitFor(() => expect(retry).not.toBeDisabled())

    fetchMock.mockResolvedValueOnce(okResponse({ kind: 'Status', status: 'Success' }))
    vi.mocked(api.getMcpServers).mockResolvedValue({ items: [] })
    fireEvent.click(retry)

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Connector mcp-server/srv deleted.', {
        tone: 'success',
      })
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/control-api/api/v1/admin/mcp-servers/srv',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(screen.queryByText(/Connector uninstall is incomplete/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete srv' })).not.toBeInTheDocument()
  })

  it('keeps both the incomplete-uninstall message and a failed list refresh visible', async () => {
    fetchMock.mockResolvedValueOnce(uninstallIncompleteResponse(SECRETS_PENDING_BODY))
    render(<McpServersPage />)
    const deleteButton = await screen.findByRole('button', { name: 'Delete srv' })
    vi.mocked(api.getMcpServers).mockRejectedValueOnce(new Error('503 Service Unavailable - down'))

    fireEvent.click(deleteButton)

    expect(
      await screen.findByText(
        'mcp-server/srv: Connector uninstall is incomplete (pending cleanup: connector Secrets). ' +
          'The connector is still installed; retry the delete to finish. ' +
          'The list could not be refreshed: 503 Service Unavailable - down'
      )
    ).toBeInTheDocument()
  })
})
