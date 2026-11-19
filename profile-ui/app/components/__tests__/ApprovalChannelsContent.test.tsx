import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { preferredAccountOptionLabel } from '@lib/approvalChannels'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'
import type { NotificationPreferences } from '@/app/types/profile'
import { ApprovalChannelsContent } from '../../settings/ApprovalChannelsContent'

const mocks = vi.hoisted(() => ({
  getNotificationPreferences: vi.fn(),
  listWorkflowApprovalMediums: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  showToast: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}))

const profileAccess = vi.hoisted(() => ({
  approvalTargets: [] as ApprovalChannelTarget[],
  approvalTargetsLoading: false,
  refreshApprovalTargets: vi.fn(),
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
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ProfileBodySkeleton', () => ({
  ProfileBodySkeleton: () => null,
}))

vi.mock('@components/ReleaseLabel', () => ({
  ReleaseLabel: () => null,
}))

vi.mock('@components/ProfileAccessContext', () => ({
  useProfileAccess: () => ({
    approvalTargets: profileAccess.approvalTargets,
    approvalTargetsLoading: profileAccess.approvalTargetsLoading,
    refreshApprovalTargets: profileAccess.refreshApprovalTargets,
  }),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))

vi.mock('@lib/api', () => ({
  getNotificationPreferences: mocks.getNotificationPreferences,
  isSilentApiError: () => false,
  updateNotificationPreferences: mocks.updateNotificationPreferences,
}))

vi.mock('@lib/approvalChannels', async importOriginal => {
  const original = await importOriginal<typeof import('@lib/approvalChannels')>()
  return { ...original, listWorkflowApprovalMediums: mocks.listWorkflowApprovalMediums }
})

function renderTab() {
  return render(<ApprovalChannelsContent />)
}

beforeEach(() => {
  vi.clearAllMocks()
  profileAccess.approvalTargets = [target]
  profileAccess.approvalTargetsLoading = false
  profileAccess.refreshApprovalTargets.mockResolvedValue(undefined)
  mocks.listWorkflowApprovalMediums.mockResolvedValue([slackAccount])
  mocks.getNotificationPreferences.mockResolvedValue(selectedPreferences)
})

afterEach(cleanup)

describe('Settings approval channels tab structure', () => {
  it('renders the settings tabs with the approval channels tab active', async () => {
    renderTab()

    const tabs = await screen.findByRole('tablist', { name: 'Settings sections' })
    expect(within(tabs).getByRole('tab', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/settings/profile'
    )
    const approvalTab = within(tabs).getByRole('tab', { name: 'Approval channels' })
    expect(approvalTab).toHaveAttribute('href', '/settings/approval-channels')
    expect(approvalTab).toHaveAttribute('aria-selected', 'true')
    expect(within(tabs).getByRole('tab', { name: 'Profile' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })

  it('explains the preferred-channel section without a redundant Manage button', async () => {
    renderTab()

    await screen.findByText(preferredAccountOptionLabel(slackAccount))
    expect(screen.getByRole('heading', { name: 'Preferred approval channel' })).toBeInTheDocument()
    expect(screen.queryByText('Manage')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })

  it('renders the settings header with refresh and the approval channels refresh contract', async () => {
    renderTab()

    const refreshButton = await screen.findByRole('button', { name: 'Refresh approval channels' })
    expect(refreshButton).toBeInTheDocument()
    expect(screen.queryByText('Profile settings')).toBeNull()
    expect(screen.queryByText(/Signed in as/)).toBeNull()
  })
})

describe('Approval channels preferred channel editing', () => {
  it('stages an automatic preference and persists it only after Save', async () => {
    const automaticPreferences: NotificationPreferences = {
      ...selectedPreferences,
      preferredMedium: null,
      preferredAccountId: null,
    }
    mocks.updateNotificationPreferences.mockResolvedValue(automaticPreferences)
    renderTab()

    const expectedLabel = preferredAccountOptionLabel(slackAccount)
    expect(await screen.findByText(expectedLabel)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Preferred channel' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit preferred channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit preferred approval channel' })
    const select = within(dialog).getByRole('combobox', { name: 'Preferred channel' })
    expect(select).toHaveValue(slackAccount.id)

    fireEvent.change(select, { target: { value: '' } })
    expect(mocks.updateNotificationPreferences).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Edit preferred channel' }).parentElement
    ).toHaveTextContent(expectedLabel)
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
    renderTab()

    const expectedLabel = preferredAccountOptionLabel(slackAccount)
    await screen.findByText(expectedLabel)
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
    expect(screen.getByText(expectedLabel)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit preferred channel' }))
    expect(await screen.findByRole('combobox', { name: 'Preferred channel' })).toHaveValue(
      slackAccount.id
    )
  })

  it('returns to the Profile tab when the account has no external channel access', async () => {
    profileAccess.approvalTargets = []
    renderTab()

    await waitFor(() => expect(mocks.routerReplace).toHaveBeenCalledWith('/settings/profile'))
  })
})
