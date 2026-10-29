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
  }: {
    title: React.ReactNode
    error?: string
    children: React.ReactNode
  }) => (
    <main>
      <h1>{title}</h1>
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

function mockMemberSections() {
  vi.mocked(api.getContexts).mockResolvedValue({ items: [] })
  vi.mocked(api.getAdminUserContexts).mockResolvedValue({ contextIds: [], deletedContextIds: [] })
  vi.mocked(api.getAdminTeams).mockResolvedValue({ items: [] })
  vi.mocked(api.getAdminUserTeams).mockResolvedValue({ items: [] })
  vi.mocked(api.getHosts).mockResolvedValue({ items: [] })
  vi.mocked(api.getAdminUserAgents).mockResolvedValue({ agentNames: [], deletedAgentNames: [] })
  vi.mocked(api.apiGet).mockResolvedValue({ items: [] })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Member Contact tab home folder', () => {
  it('shows the home folder as the last Contact field, after Telegram IDs', async () => {
    vi.mocked(api.getAdminUserContext).mockResolvedValue({
      id: userId,
      email: 'member@example.test',
      name: 'Member',
      picture: null,
      displayName: 'Member',
      channels: { emails: [], slackUserNames: [], telegramIds: [] },
    })
    vi.mocked(api.getGfsUserHome).mockResolvedValue({
      home: {
        userId,
        email: 'member@example.test',
        name: 'Member',
        state: 'ready',
        drive: 'main',
        storageUsername: 'member',
        path: '/Users/member',
        resourceId: 'resource-1',
        conflictCode: null,
        lastError: null,
        attempts: 1,
        lastAttemptAt: null,
        updatedAt: '2026-10-27T00:00:00.000Z',
        conflictDetail: null,
      },
    })
    mockMemberSections()
    render(<UserDetailsPage />)

    const field = await screen.findByRole('region', { name: 'Home folder' })
    expect(await screen.findByText('/Users/member')).toBeVisible()
    const telegram = screen.getByText('Telegram IDs').closest('.cu-field')
    expect(telegram).not.toBeNull()
    // Same stack, immediately after Telegram IDs.
    expect(telegram!.nextElementSibling).toBe(field)
    expect(api.getGfsUserHome).toHaveBeenCalledWith(userId, expect.any(AbortSignal))
  })

  it('keeps a member 404 as the page error and never reads a home for it', async () => {
    vi.mocked(api.getAdminUserContext).mockRejectedValue(
      Object.assign(new Error('not found'), { status: 404 })
    )
    mockMemberSections()
    render(<UserDetailsPage />)

    const error = await screen.findByText('not found')
    expect(error).toHaveAttribute('role', 'alert')
    // Witness: the member context was requested; the home was not.
    expect(api.getAdminUserContext).toHaveBeenCalledWith(userId)
    expect(api.getGfsUserHome).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Home folder' })).not.toBeInTheDocument()
  })
})
