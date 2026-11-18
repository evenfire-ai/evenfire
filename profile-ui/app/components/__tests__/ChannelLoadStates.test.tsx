import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ApprovalChannelTarget } from '@/app/types/approvalChannels'
import producerOutput from '@/test/fixtures/telegram-channel-accounts.json'
import { ChannelsContent } from '../../channels/ChannelsContent'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isSilentApiError: vi.fn(),
  listWorkflowApprovalMediums: vi.fn(),
  refreshApprovalTargets: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm, confirmDialog: null }),
}))

const profileAccess = vi.hoisted(() => ({
  targets: [] as Array<{ id: string; medium: string }>,
  loading: false,
}))

vi.mock('@components/ProfileAccessContext', () => ({
  useProfileAccess: () => ({
    approvalTargets: profileAccess.targets,
    approvalTargetsError: false,
    approvalTargetsLoading: profileAccess.loading,
    canManageMembers: false,
    manageableTeams: [],
    manageableTeamsError: false,
    manageableTeamsLoading: false,
    refreshApprovalTargets: mocks.refreshApprovalTargets,
    refreshManageableTeams: vi.fn(),
  }),
}))

vi.mock('@components/ProfileBodySkeleton', () => ({
  ProfileBodySkeleton: () => <div className="profile-skeleton" role="status" />,
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))

vi.mock('@lib/api', () => ({
  isSilentApiError: mocks.isSilentApiError,
}))

vi.mock('@lib/approvalChannels', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/approvalChannels')>()),
  disconnectWorkflowApprovalMedium: vi.fn(),
  listWorkflowApprovalMediums: mocks.listWorkflowApprovalMediums,
}))

vi.mock('../../channels/TelegramVerificationPanel', async importOriginal => {
  const original = await importOriginal<typeof import('../../channels/TelegramVerificationPanel')>()
  return {
    TelegramVerificationPanel: (
      props: React.ComponentProps<typeof original.TelegramVerificationPanel>
    ) => (
      <div data-testid="channel-panel" data-connect-request-count={props.connectRequestCount ?? 0}>
        <original.TelegramVerificationPanel {...props} />
      </div>
    ),
  }
})

function target(id: string, medium: string): ApprovalChannelTarget {
  return { id, medium } as ApprovalChannelTarget
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isSilentApiError.mockReturnValue(false)
  mocks.listWorkflowApprovalMediums.mockResolvedValue([])
  mocks.refreshApprovalTargets.mockResolvedValue([])
  profileAccess.targets = [target('tg-1', 'telegram'), target('slack-1', 'slack')]
  profileAccess.loading = false
})

afterEach(cleanup)

describe('Social channel loading and targetless records', () => {
  it('keeps disconnected records actionable without offering an unavailable Connect action', async () => {
    profileAccess.targets = []
    mocks.listWorkflowApprovalMediums.mockResolvedValue(producerOutput.disabled)
    render(<ChannelsContent activeChannel="telegram" />)
    expect(await screen.findByText('Disconnected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Connect / })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Telegram conversation' }))
    expect(await screen.findByRole('menuitem', { name: 'Remove record' })).toBeInTheDocument()
  })

  it('shows a failed load without claiming the account has no channels', async () => {
    profileAccess.targets = []
    mocks.listWorkflowApprovalMediums.mockRejectedValue(new Error('Service unavailable'))
    render(<ChannelsContent activeChannel="telegram" />)
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No social channels are set up yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh social channels' })).toBeEnabled()
  })

  it('shows the empty message only after a successful empty load', async () => {
    profileAccess.targets = []
    render(<ChannelsContent activeChannel="telegram" />)
    expect(await screen.findByText('No social channels are set up yet.')).toBeInTheDocument()
  })
})
