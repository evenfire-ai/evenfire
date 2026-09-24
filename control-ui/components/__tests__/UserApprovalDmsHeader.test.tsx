import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import UserDetailsPage from '../../app/profile-admin/users/[userId]/page'
import * as api from '../../lib/api'
import * as approvalMediums from '../../lib/workflowApprovalMediums'

const mocks = vi.hoisted(() => ({
  getApprovalMediums: vi.fn(),
  resolveRoute: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ userId: 'user-1', tab: 'approval-dms' }),
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.resolveRoute, confirmDialog: null }),
}))

vi.mock('@components/DetailPageShell', () => ({
  DetailPageShell: ({
    actions,
    activeTab,
    children,
    onTabChange,
    tabs,
  }: {
    actions: React.ReactNode
    activeTab: string
    children: React.ReactNode
    onTabChange: (tab: string) => void
    tabs: Array<{ label: string; value: string }>
  }) => (
    <main>
      {actions}
      <nav aria-label="Member sections">
        {tabs.map(tab => (
          <button
            aria-current={activeTab === tab.value ? 'page' : undefined}
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {children}
    </main>
  ),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))

vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getAdminUserContext: vi.fn().mockResolvedValue({
      channels: { emails: [], slackUserNames: [], telegramIds: [] },
      email: 'ada@example.invalid',
      name: 'Ada Lovelace',
    }),
    getContexts: vi.fn().mockResolvedValue({ items: [] }),
    getAdminUserContexts: vi.fn().mockResolvedValue({ contextIds: [], deletedContextIds: [] }),
    getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
    getAdminUserTeams: vi.fn().mockResolvedValue({ items: [] }),
    getHosts: vi.fn().mockResolvedValue({ items: [] }),
    getAdminUserAgents: vi.fn().mockResolvedValue({ agentNames: [], deletedAgentNames: [] }),
    apiGet: vi.fn().mockResolvedValue({ items: [] }),
  }
})

vi.mock('../../lib/workflowApprovalMediums', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/workflowApprovalMediums')>()
  return { ...actual, getAdminUserWorkflowApprovalMediums: mocks.getApprovalMediums }
})

afterEach(cleanup)

describe('UserDetailsPage Approval DM refresh action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('wires the header refresh button to the active panel and its loading state', async () => {
    let finishFirstLoad!: (value: { items: never[] }) => void
    let finishRefresh!: (value: { items: never[] }) => void
    mocks.getApprovalMediums
      .mockImplementationOnce(() => new Promise(resolve => (finishFirstLoad = resolve)))
      .mockImplementationOnce(() => new Promise(resolve => (finishRefresh = resolve)))

    render(<UserDetailsPage />)

    const refresh = screen.getByRole('button', { name: 'Reload approval DMs' })
    expect(refresh).toBeDisabled()
    finishFirstLoad({ items: [] })
    await waitFor(() => expect(refresh).toBeEnabled())

    fireEvent.click(refresh)
    expect(mocks.getApprovalMediums).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(refresh).toBeDisabled())
    finishRefresh({ items: [] })
    await waitFor(() => expect(refresh).toBeEnabled())

    expect(api.getAdminUserContext).toHaveBeenCalledWith('user-1')
    expect(approvalMediums.getAdminUserWorkflowApprovalMediums).toHaveBeenCalledWith('user-1')
  })

  it('clears and re-registers the header refresh action when switching tabs', async () => {
    mocks.getApprovalMediums.mockResolvedValue({ items: [] })
    render(<UserDetailsPage />)

    const refresh = screen.getByRole('button', { name: 'Reload approval DMs' })
    await waitFor(() => expect(refresh).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Contact' }))
    expect(screen.queryByRole('button', { name: 'Reload approval DMs' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Approval DMs' }))
    const reloadedRefresh = screen.getByRole('button', { name: 'Reload approval DMs' })
    await waitFor(() => expect(reloadedRefresh).toBeEnabled())
    fireEvent.click(reloadedRefresh)

    await waitFor(() => expect(mocks.getApprovalMediums).toHaveBeenCalledTimes(3))
  })
})
