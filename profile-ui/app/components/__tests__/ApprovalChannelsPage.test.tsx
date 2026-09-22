import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'
import type { NotificationPreferences } from '@/app/types/profile'
import ApprovalChannelsPage from '../../approval-channels/page'

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkflowApprovalMediums: vi.fn(),
  refreshApprovalTargets: vi.fn(),
  routerPush: vi.fn(),
  showToast: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}))

const target: ApprovalChannelTarget = {
  id: 'target-1',
  medium: 'slack',
  agentName: 'Support agent',
  channelName: 'approvals',
  channelNamespace: 'default',
  botLabel: 'Evenfire',
  botUsername: null,
  botDeepLink: null,
  status: 'ready',
}

const slackAccount: WorkflowApprovalMediumAccount = {
  id: 'account-1',
  userId: 'user-1',
  medium: 'slack',
  providerUserId: 'provider-user-1',
  providerWorkspaceId: 'workspace-1',
  providerChannelId: 'channel-1',
  displayName: 'Operations',
  targets: [target],
}

const selectedPreferences: NotificationPreferences = {
  preferredMedium: 'slack',
  preferredAccountId: slackAccount.id,
  channelFallbackEnabled: true,
  verifiedMedia: ['slack'],
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ProfileAccessContext', () => ({
  useProfileAccess: () => ({
    approvalTargets: [target],
    refreshApprovalTargets: mocks.refreshApprovalTargets,
  }),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))

vi.mock('@lib/api', () => ({
  getMe: mocks.getMe,
  getNotificationPreferences: mocks.getNotificationPreferences,
  isSilentApiError: () => false,
  updateNotificationPreferences: mocks.updateNotificationPreferences,
}))

vi.mock('@lib/approvalChannels', () => ({
  activeApprovalAccounts: (accounts: WorkflowApprovalMediumAccount[]) =>
    accounts.filter(account => !account.disabledAt),
  listWorkflowApprovalMediums: mocks.listWorkflowApprovalMediums,
  preferredAccountOptionLabel: (account: WorkflowApprovalMediumAccount) =>
    `${account.displayName} · Slack`,
}))

function renderPage() {
  return render(<ApprovalChannelsPage />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getMe.mockResolvedValue({ id: 'user-1', email: 'user@example.com' })
  mocks.refreshApprovalTargets.mockResolvedValue(undefined)
  mocks.listWorkflowApprovalMediums.mockResolvedValue([slackAccount])
  mocks.getNotificationPreferences.mockResolvedValue(selectedPreferences)
})

afterEach(cleanup)

describe('ApprovalChannelsPage preferred channel editing', () => {
  it('stages an automatic preference and persists it only after Save', async () => {
    const automaticPreferences: NotificationPreferences = {
      ...selectedPreferences,
      preferredMedium: null,
      preferredAccountId: null,
    }
    mocks.updateNotificationPreferences.mockResolvedValue(automaticPreferences)
    renderPage()

    expect(await screen.findByText('Operations · Slack')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Preferred channel' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit preferred channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit preferred approval channel' })
    const select = within(dialog).getByRole('combobox', { name: 'Preferred channel' })
    expect(select).toHaveValue(slackAccount.id)

    fireEvent.change(select, { target: { value: '' } })
    expect(mocks.updateNotificationPreferences).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Edit preferred channel' }).parentElement
    ).toHaveTextContent('Operations · Slack')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mocks.updateNotificationPreferences).toHaveBeenCalledWith({
        preferredMedium: null,
        preferredAccountId: null,
        channelFallbackEnabled: true,
      })
    )
    expect(mocks.updateNotificationPreferences).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit preferred approval channel' })).toBeNull()
    )
    expect(screen.getByText('Automatic (most recent channel)')).toBeInTheDocument()
  })

  it('keeps a failed draft open and discards it on cancel', async () => {
    mocks.updateNotificationPreferences.mockRejectedValue(new Error('preferred_account_not_found'))
    renderPage()

    await screen.findByText('Operations · Slack')
    fireEvent.click(screen.getByRole('button', { name: 'Edit preferred channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit preferred approval channel' })
    const select = within(dialog).getByRole('combobox', { name: 'Preferred channel' })
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That channel is no longer available. Pick another or leave Automatic.'
    )
    expect(select).toHaveValue('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Edit preferred approval channel' })).toBeNull()
    expect(screen.getByText('Operations · Slack')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit preferred channel' }))
    expect(await screen.findByRole('combobox', { name: 'Preferred channel' })).toHaveValue(
      slackAccount.id
    )
  })
})
