/**
 * Tests for RecipeIntegrationsPanel — per-user background grants subsection.
 *
 * These tests cover the "Show users" toggle, user row rendering, and the
 * Revoke admin action on the per-user grants subsection that appears when
 * an oauthClient has backgroundAccess: true.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkflowRecipeResource } from '../../lib/api'
import { ToastProvider } from '../Toast'

// ── Mock declarations ────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  adminListUserGrants: vi.fn(),
  adminRevokeUserGrant: vi.fn(),
  getRecipeOauthStatus: vi.fn(),
  connectRecipeOauth: vi.fn(),
  disconnectRecipeOauth: vi.fn(),
  confirm: vi.fn<(opts?: unknown) => Promise<boolean>>(),
}))

vi.mock('../../lib/api', () => ({
  adminListUserGrants: mocks.adminListUserGrants,
  adminRevokeUserGrant: mocks.adminRevokeUserGrant,
  getRecipeOauthStatus: mocks.getRecipeOauthStatus,
  connectRecipeOauth: mocks.connectRecipeOauth,
  disconnectRecipeOauth: mocks.disconnectRecipeOauth,
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: mocks.confirm,
    confirmDialog: null,
  }),
}))

vi.mock('../TablePanelHeader', () => ({
  TablePanelHeader: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <header>
      <span>{title}</span>
      {actions}
    </header>
  ),
}))

vi.mock('../icons', () => ({
  IconRefresh: () => <span data-testid="icon-refresh" />,
}))

import { RecipeIntegrationsPanel } from '../RecipeIntegrationsPanel'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const recipe: WorkflowRecipeResource = {
  metadata: { name: 'crm-recipe' },
  spec: {
    oauthClients: [{ id: 'salesforce', provider: 'Salesforce', backgroundAccess: true }],
  },
}

const oneUserGrant = [
  { userId: 'user-abc-123', background: true, updatedAt: '2026-06-01T10:00:00.000Z' },
]

function renderPanel() {
  const user = userEvent.setup({ delay: null })
  return {
    ...render(
      <ToastProvider>
        <RecipeIntegrationsPanel recipe={recipe} />
      </ToastProvider>,
    ),
    user,
  }
}

/**
 * Render the panel, wait for status to load, click "Show users", and wait for
 * the resolved user grants to appear. Returns `user` for further interactions.
 */
async function renderAndExpandGrants() {
  let resolveGrants!: (v: { users: typeof oneUserGrant }) => void
  mocks.adminListUserGrants.mockImplementationOnce(
    () =>
      new Promise<{ users: typeof oneUserGrant }>(res => {
        resolveGrants = res
      })
  )

  const { user } = renderPanel()

  // Wait for initial status fetch ("Not connected" or any status chip appears)
  await screen.findByText('Not connected')

  // Click "Show users" to trigger loadUserGrants()
  await user.click(screen.getByRole('button', { name: /Show users/i }))

  // Confirm the subsection is expanded and loading
  await screen.findByText('Per-user connections')
  await screen.findByText('Loading…')

  // Resolve the grants fetch inside act() so React flushes state updates
  await act(async () => {
    resolveGrants({ users: oneUserGrant })
  })

  return { user }
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRecipeOauthStatus.mockResolvedValue({ connected: false })
  mocks.adminListUserGrants.mockResolvedValue({ users: oneUserGrant })
  mocks.adminRevokeUserGrant.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RecipeIntegrationsPanel — per-user grants subsection', () => {
  it('renders the backgroundAccess oauthClient table row after status loads', async () => {
    renderPanel()

    await waitFor(() => expect(screen.getByText('salesforce')).toBeInTheDocument())
    expect(screen.getByText('Salesforce')).toBeInTheDocument()
    expect(screen.getByText('Not connected')).toBeInTheDocument()

    // "Show users" button present and enabled when recipeName is set
    const showBtn = screen.getByRole('button', { name: /Show users/i })
    expect(showBtn).toBeInTheDocument()
    expect(showBtn).not.toBeDisabled()
  })

  it('clicking "Show users" calls adminListUserGrants(recipeName, oauthClientId)', async () => {
    const { user } = renderPanel()
    await screen.findByText('Not connected')

    await user.click(screen.getByRole('button', { name: /Show users/i }))

    await waitFor(() =>
      expect(mocks.adminListUserGrants).toHaveBeenCalledWith('crm-recipe', 'salesforce')
    )
  })

  it('shows "Per-user connections" heading and loading indicator while fetching', async () => {
    // Keep the fetch open so the panel stays in loading state
    mocks.adminListUserGrants.mockReturnValue(new Promise(() => {}))

    const { user } = renderPanel()
    await screen.findByText('Not connected')

    await user.click(screen.getByRole('button', { name: /Show users/i }))

    await screen.findByText('Per-user connections')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    // Toggle button flips to "Hide users" while expanded
    expect(screen.getByRole('button', { name: /Hide users/i })).toBeInTheDocument()
  })

  it('renders the user row after adminListUserGrants resolves', async () => {
    await renderAndExpandGrants()

    await waitFor(() => expect(screen.getByText('user-abc-123')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Revoke/i })).toBeInTheDocument()
  })

  it('calls adminRevokeUserGrant when admin confirms the revoke dialog', async () => {
    mocks.confirm.mockResolvedValue(true)

    await renderAndExpandGrants()

    await waitFor(() => screen.getByRole('button', { name: /Revoke/i }))

    // Reset after initial load so the post-revoke reload doesn't confuse assertions
    mocks.adminListUserGrants.mockResolvedValue({ users: [] })

    const { user } = { user: userEvent.setup({ delay: null }) }
    await user.click(screen.getByRole('button', { name: /Revoke/i }))

    await waitFor(() =>
      expect(mocks.adminRevokeUserGrant).toHaveBeenCalledWith(
        'crm-recipe',
        'salesforce',
        'user-abc-123'
      )
    )
  })

  it('does NOT call adminRevokeUserGrant when the confirm dialog is cancelled', async () => {
    mocks.confirm.mockResolvedValue(false)

    await renderAndExpandGrants()

    await waitFor(() => screen.getByRole('button', { name: /Revoke/i }))

    const { user } = { user: userEvent.setup({ delay: null }) }
    await user.click(screen.getByRole('button', { name: /Revoke/i }))

    // Give any pending promises a tick to settle
    await new Promise(r => setTimeout(r, 0))

    expect(mocks.adminRevokeUserGrant).not.toHaveBeenCalled()
  })

  it('confirm dialog uses tone:danger', async () => {
    mocks.confirm.mockImplementationOnce(async opts => {
      expect((opts as { tone?: string }).tone).toBe('danger')
      return false
    })

    await renderAndExpandGrants()

    await waitFor(() => screen.getByRole('button', { name: /Revoke/i }))

    const { user } = { user: userEvent.setup({ delay: null }) }
    await user.click(screen.getByRole('button', { name: /Revoke/i }))

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
  })
})
