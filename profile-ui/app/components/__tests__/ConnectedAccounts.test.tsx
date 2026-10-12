import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Page from '../../connected-accounts/page'

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
}))

const toast = vi.hoisted(() => ({ showToast: vi.fn() }))

// Real listConnectedAccounts/revokeConnectedAccount run against these mocks; the
// wire shape below is the frozen GrantView contract the backend emits.
vi.mock('@lib/api', () => ({
  apiGet: api.apiGet,
  apiSend: api.apiSend,
  isSilentApiError: () => false,
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => toast,
}))

const recipeGrant = {
  ownerKind: 'recipe',
  recipeNamespace: 'team-ns',
  recipeName: 'calendar-plugin',
  oauthClientId: 'google',
  provider: 'google',
  background: true,
  updatedAt: '2026-09-20T00:00:00.000Z',
}

// mcp-server grant on the remote lane. Name deliberately free of the substring
// "remote" so the assertion proves the raw provider token is hidden, not masked
// by the server name.
const remoteMcpServerGrant = {
  ownerKind: 'mcpserver',
  recipeNamespace: 'servers-ns',
  recipeName: 'acme-crm',
  mcpServerName: 'acme-crm',
  oauthClientId: 'https://acme.example.com/oauth/callback',
  provider: 'remote',
  background: false,
  updatedAt: '2026-09-20T00:00:00.000Z',
}

beforeEach(() => {
  api.apiGet.mockReset()
  api.apiSend.mockReset()
  toast.showToast.mockReset()
})

afterEach(cleanup)

describe('Connected accounts — mixed owner rendering', () => {
  it('renders recipe and mcp-server grants with an owner-kind type label', async () => {
    api.apiGet.mockResolvedValue({ grants: [recipeGrant, remoteMcpServerGrant] })

    render(<Page />)

    expect(await screen.findByText('calendar-plugin')).toBeInTheDocument()
    expect(screen.getByText('acme-crm')).toBeInTheDocument()

    // Owner-kind labels are derived from ownerKind, never from the name.
    expect(screen.getByText(/Plugin/)).toBeInTheDocument()
    expect(screen.getByText(/MCP server/)).toBeInTheDocument()
    // Recipe provider still shows.
    expect(screen.getByText(/google/)).toBeInTheDocument()
  })

  it('hides the raw remote provider token for the mcp-server grant', async () => {
    api.apiGet.mockResolvedValue({ grants: [remoteMcpServerGrant] })

    render(<Page />)

    await screen.findByText('acme-crm')
    // The synthetic 'remote' provider token must never surface in the UI.
    expect(document.body.textContent).not.toMatch(/remote/i)
  })

  it('shows a baked mcp-server provider instead of the type label alone', async () => {
    api.apiGet.mockResolvedValue({
      grants: [{ ...remoteMcpServerGrant, provider: 'clickup' }],
    })

    render(<Page />)

    await screen.findByText('acme-crm')
    expect(screen.getByText(/clickup/)).toBeInTheDocument()
  })

  it('revokes an mcp-server grant through its owner-kind lane and drops it from the list', async () => {
    api.apiGet
      .mockResolvedValueOnce({ grants: [recipeGrant, remoteMcpServerGrant] })
      .mockResolvedValue({ grants: [recipeGrant] })
    api.apiSend.mockResolvedValue(null)

    render(<Page />)

    await screen.findByText('acme-crm')

    fireEvent.click(screen.getByRole('button', { name: 'Actions for acme-crm' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Revoke' }))

    await waitFor(() => expect(api.apiSend).toHaveBeenCalledTimes(1))
    const [method, path, body, query] = api.apiSend.mock.calls[0]
    expect(method).toBe('DELETE')
    expect(path).toBe(
      `/api/v1/oauth/grants/servers-ns/acme-crm/${encodeURIComponent(
        'https://acme.example.com/oauth/callback'
      )}`
    )
    expect(body).toBeUndefined()
    expect(query).toEqual({ ownerKind: 'mcpserver' })

    // Observable result (T4): the revoked grant is gone from the rendered list.
    await waitFor(() => expect(screen.queryByText('acme-crm')).not.toBeInTheDocument())
    expect(screen.getByText('calendar-plugin')).toBeInTheDocument()
  })
})
