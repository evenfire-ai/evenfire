import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ApprovalChannelTarget } from '@/app/types/approvalChannels'
import producerOutput from '@/test/fixtures/telegram-channel-accounts.json'
import { TelegramVerificationPanel } from '../../channels/TelegramVerificationPanel'

vi.mock('@components/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
const mocks = vi.hoisted(() => ({ createChallenge: vi.fn() }))
vi.mock('@lib/approvalChannels', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/approvalChannels')>()),
  createWorkflowApprovalMediumChallenge: mocks.createChallenge,
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function ConnectHarness() {
  const [count, setCount] = useState(0)
  return (
    <>
      <button onClick={() => setCount(value => value + 1)}>Connect Telegram</button>
      <TelegramVerificationPanel
        accounts={[]}
        targets={producerOutput.targets.slice(0, 1) as ApprovalChannelTarget[]}
        disabled={false}
        connectRequestCount={count}
        onAccountsRefresh={async () => []}
        onRemoveAccount={() => {}}
      />
    </>
  )
}

describe('Channel connection keyboard behavior', () => {
  it('moves focus inside and restores the opener after Escape', async () => {
    render(<ConnectHarness />)
    const opener = screen.getByRole('button', { name: 'Connect Telegram' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Verify your Telegram channel' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('wraps Tab and Shift+Tab inside the dialog', async () => {
    render(<ConnectHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
    const dialog = await screen.findByRole('dialog')
    const first = within(dialog).getByRole('button', { name: 'Close' })
    const last = within(dialog).getByRole('button', { name: 'Continue' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('focuses the dialog when row Connect opens with a pending challenge', async () => {
    mocks.createChallenge.mockReturnValue(new Promise(() => {}))
    render(<ConnectHarness />)
    const actions = screen.getByRole('button', { name: /Actions for/ })
    actions.focus()
    fireEvent.click(actions)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Connect' }))
    const dialog = await screen.findByRole('dialog')
    expect(mocks.createChallenge).toHaveBeenCalledTimes(1)
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('prevents Escape and backdrop dismissal while starting a challenge', async () => {
    mocks.createChallenge.mockReturnValue(new Promise(() => {}))
    render(<ConnectHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'))
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled()
  })
})
