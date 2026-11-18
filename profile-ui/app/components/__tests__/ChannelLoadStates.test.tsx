import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApprovalChannelTarget } from '@/app/types/approvalChannels'
import producerOutput from '@/test/fixtures/telegram-channel-accounts.json'
import { ChannelsContent } from '../../channels/ChannelsContent'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  disconnect: vi.fn(),
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
  disconnectWorkflowApprovalMedium: mocks.disconnect,
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
  it.each(['telegram', 'slack', 'teams'] as const)(
    'hides disconnected %s records on load',
    async medium => {
      profileAccess.targets = []
      mocks.listWorkflowApprovalMediums.mockResolvedValue(
        producerOutput.disabled.map(account => ({ ...account, medium }))
      )
      render(<ChannelsContent activeChannel={medium} />)
      expect(await screen.findByText('No social channels are set up yet.')).toBeInTheDocument()
      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Connect / })).not.toBeInTheDocument()
    }
  )

  it.each(['telegram', 'slack', 'teams'] as const)(
    'removes the %s account row after disconnect and refresh',
    async medium => {
      const availableTarget = { ...producerOutput.targets[0]!, medium }
      profileAccess.targets = [availableTarget]
      const account = {
        ...producerOutput.disabled[0]!,
        medium,
        disabledAt: null,
        displayName: 'Demo connection',
        targets: [availableTarget],
      }
      const disconnected = {
        ...account,
        disabledAt: producerOutput.disabled[0]!.disabledAt,
        targets: [],
      }
      mocks.listWorkflowApprovalMediums.mockResolvedValue([account])
      mocks.confirm.mockResolvedValue(true)
      mocks.disconnect.mockImplementation(async () => {
        mocks.listWorkflowApprovalMediums.mockResolvedValue([disconnected])
      })
      render(<ChannelsContent activeChannel={medium} />)
      expect(await screen.findByText('Demo connection')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Actions for Demo connection' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete connection' }))
      await waitFor(() => expect(screen.queryByText('Demo connection')).not.toBeInTheDocument())
      expect(mocks.disconnect).toHaveBeenCalledWith(account.id)
      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
      expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)
      expect(screen.queryByRole('menuitem', { name: 'Delete connection' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh social channels' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Refresh social channels' })).toBeEnabled()
      )
      expect(screen.queryByText('Demo connection')).not.toBeInTheDocument()
      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
      expect(
        mocks.listWorkflowApprovalMediums.mock.calls.every(args => !args[0]?.includeDisabled)
      ).toBe(true)
    }
  )

  it.each([false, true])(
    'shows a failed load without empty panels (targets present: %s)',
    async hasTargets => {
      profileAccess.targets = hasTargets ? producerOutput.targets : []
      mocks.listWorkflowApprovalMediums.mockRejectedValue(new Error('Service unavailable'))
      render(<ChannelsContent activeChannel="telegram" />)
      expect(await screen.findByText('Service unavailable')).toBeInTheDocument()
      expect(screen.queryByTestId('channel-panel')).not.toBeInTheDocument()
      expect(screen.queryByText('No social channels are set up yet.')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh social channels' })).toBeEnabled()
    }
  )

  it('shows the empty message only after a successful empty load', async () => {
    profileAccess.targets = []
    render(<ChannelsContent activeChannel="telegram" />)
    expect(await screen.findByText('No social channels are set up yet.')).toBeInTheDocument()
  })
})
