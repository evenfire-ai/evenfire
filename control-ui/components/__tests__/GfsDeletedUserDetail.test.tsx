import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as api from '@lib/api'
import UserDetailsPage from '../../app/profile-admin/users/[userId]/page'

const userId = '11111111-1111-4111-8111-111111111111'
vi.mock('next/navigation', () => ({
  useParams: () => ({ userId }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))
vi.mock('@components/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('@components/DetailPageShell', () => ({
  DetailPageShell: ({
    title,
    error,
    children,
    actions,
  }: {
    title: React.ReactNode
    error?: string
    children: React.ReactNode
    actions?: React.ReactNode
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {error ? <p role="alert">{error}</p> : null}
      {children}
    </main>
  ),
}))
vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  getAdminUserContext: vi.fn(),
  getGfsUserHome: vi.fn(),
  getContexts: vi.fn(),
  getAdminUserContexts: vi.fn(),
  getAdminTeams: vi.fn(),
  getAdminUserTeams: vi.fn(),
  getHosts: vi.fn(),
  getAdminUserAgents: vi.fn(),
  apiGet: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Retained home of a deleted user', () => {
  it('shows the retained home and keeps the ordinary user detail working', async () => {
    const home: api.GfsUserHomeDetail = {
      userId,
      email: null,
      name: null,
      state: 'retired',
      drive: 'main',
      storageUsername: 'former',
      path: '/Users/former',
      resourceId: 'resource-1',
      conflictCode: null,
      lastError: null,
      attempts: 1,
      lastAttemptAt: null,
      updatedAt: '2026-10-27T00:00:00.000Z',
      conflictDetail: null,
    }
    vi.mocked(api.getAdminUserContext).mockRejectedValueOnce(
      Object.assign(new Error('not found'), { status: 404 })
    )
    vi.mocked(api.getGfsUserHome).mockResolvedValue({ home })
    render(<UserDetailsPage />)
    expect(await screen.findByRole('heading', { name: 'Deleted user' })).toBeVisible()
    expect(screen.getByText(`User ID: ${userId}`)).toBeVisible()
    expect(await screen.findByText('/Users/former')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Delete account…' })).not.toBeInTheDocument()

    cleanup()
    vi.mocked(api.getAdminUserContext).mockResolvedValueOnce({
      id: userId,
      email: 'member@example.test',
      name: 'Member',
      picture: null,
      displayName: 'Member',
      channels: { emails: [], slackUserNames: [], telegramIds: [] },
    })
    vi.mocked(api.getGfsUserHome).mockResolvedValue({
      home: { ...home, state: 'ready', email: 'member@example.test', name: 'Member' },
    })
    vi.mocked(api.getContexts).mockResolvedValue({ items: [] })
    vi.mocked(api.getAdminUserContexts).mockResolvedValue({ contextIds: [], deletedContextIds: [] })
    vi.mocked(api.getAdminTeams).mockResolvedValue({ items: [] })
    vi.mocked(api.getAdminUserTeams).mockResolvedValue({ items: [] })
    vi.mocked(api.getHosts).mockResolvedValue({ items: [] })
    vi.mocked(api.getAdminUserAgents).mockResolvedValue({ agentNames: [], deletedAgentNames: [] })
    vi.mocked(api.apiGet).mockResolvedValue({ items: [] })
    render(<UserDetailsPage />)
    expect(await screen.findByRole('heading', { name: 'Member' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete account…' })).toBeVisible()
  })

  it('keeps the member 404 when the home is also missing', async () => {
    vi.mocked(api.getAdminUserContext).mockRejectedValueOnce(
      Object.assign(new Error('not found'), { status: 404 })
    )
    vi.mocked(api.getGfsUserHome).mockRejectedValue(
      Object.assign(new Error('404 Not Found - home_not_found'), {
        status: 404,
        code: 'home_not_found',
      })
    )
    render(<UserDetailsPage />)

    const error = await screen.findByText('not found')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).not.toHaveTextContent('home_not_found')
    // Witness: the missing-home branch read the home for this member.
    expect(api.getGfsUserHome).toHaveBeenCalledWith(userId)
  })
})
