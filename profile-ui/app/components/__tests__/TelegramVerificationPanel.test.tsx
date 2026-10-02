import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkflowApprovalMediumAccount } from '@/app/types/approvalChannels'
import { TelegramVerificationPanel } from '../../settings/TelegramVerificationPanel'
import { ToastProvider } from '../Toast'

const mocks = vi.hoisted(() => ({
  updateDisplayName: vi.fn(),
}))

vi.mock('@lib/approvalChannels', async importOriginal => {
  const original = await importOriginal<typeof import('@lib/approvalChannels')>()
  return {
    ...original,
    updateWorkflowApprovalMediumDisplayName: mocks.updateDisplayName,
  }
})

const account: WorkflowApprovalMediumAccount = {
  id: 'account-1',
  userId: 'user-1',
  medium: 'slack',
  providerUserId: 'provider-user',
  providerWorkspaceId: 'workspace-1',
  providerChannelId: 'channel-1',
  displayName: 'Operations approvals',
  targets: [],
}

afterEach(cleanup)

describe('TelegramVerificationPanel display name editing', () => {
  const onAccountsRefresh = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    onAccountsRefresh.mockResolvedValue([account])
    mocks.updateDisplayName.mockResolvedValue(undefined)
  })

  function renderPanel() {
    return render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[account]}
          disabled={false}
          medium="slack"
          onAccountsRefresh={onAccountsRefresh}
          onRemoveAccount={() => undefined}
          targets={[]}
        />
      </ToastProvider>
    )
  }

  async function openEditor() {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Operations approvals' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit display name' }))
    return screen.findByRole('dialog', { name: 'Edit conversation name' })
  }

  it('saves a changed display name and refreshes authoritative account data', async () => {
    renderPanel()
    const dialog = await openEditor()
    const input = within(dialog).getByRole('textbox', { name: 'Display name' })
    expect(input).toHaveValue('Operations approvals')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'Leadership approvals' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mocks.updateDisplayName).toHaveBeenCalledWith('account-1', 'Leadership approvals')
    )
    expect(onAccountsRefresh).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Conversation display name saved.')).toBeInTheDocument()
  })

  it('retains a failed draft and discards it on cancel', async () => {
    mocks.updateDisplayName.mockRejectedValue(new Error('Display name update failed'))
    renderPanel()
    const dialog = await openEditor()
    const input = within(dialog).getByRole('textbox', { name: 'Display name' })
    fireEvent.change(input, { target: { value: 'Retry approvals' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Display name update failed')
    expect(input).toHaveValue('Retry approvals')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    const reopened = await openEditor()
    expect(within(reopened).getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Operations approvals'
    )
  })
})
