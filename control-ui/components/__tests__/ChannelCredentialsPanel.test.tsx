import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChannelCredentialsPanel } from '../ChannelCredentialsPanel'
import type { CredentialDraft } from '../ChannelCredentialsPanel/types'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
}))

afterEach(() => cleanup())

function renderPanel(props: Parameters<typeof ChannelCredentialsPanel>[0] = { ccName: 'cc-x' }) {
  return render(
    <ToastProvider>
      <ChannelCredentialsPanel {...props} />
    </ToastProvider>
  )
}

describe('ChannelCredentialsPanel — credential field filtering', () => {
  it('shows all provider credential inputs when visibleChannelTypes is undefined', () => {
    renderPanel({ ccName: 'cc-rotate' })
    expect(screen.getByLabelText('Telegram Bot Token')).toBeInTheDocument()
    expect(screen.getByLabelText('Slack Signing Secret')).toBeInTheDocument()
    expect(screen.getByLabelText('Slack Bot User OAuth Token')).toBeInTheDocument()
    expect(screen.getByLabelText('Email Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Email Password')).toBeInTheDocument()
  })

  it('renders only the Telegram input when visibleChannelTypes=["telegram"]', () => {
    renderPanel({ ccName: 'cc-tg', visibleChannelTypes: ['telegram'] })
    expect(screen.getByLabelText('Telegram Bot Token')).toBeInTheDocument()
    expect(screen.queryByLabelText('Slack Signing Secret')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email Password')).not.toBeInTheDocument()
  })

  it('renders email username + password (both) when visibleChannelTypes=["email"]', () => {
    renderPanel({ ccName: 'cc-email', visibleChannelTypes: ['email'] })
    expect(screen.queryByLabelText('Telegram Bot Token')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Slack Signing Secret')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Email Password')).toBeInTheDocument()
  })

  it('renders the empty-state hint when visibleChannelTypes=[]', () => {
    renderPanel({ ccName: 'cc-empty', visibleChannelTypes: [] })
    expect(
      screen.getByText(/Select a communication channel provider to configure its credentials/i)
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Telegram Bot Token')).not.toBeInTheDocument()
  })

  it('prunes pending draft values whose channel type is removed', () => {
    // Simulate the wizard: user types a Telegram token while Telegram is visible,
    // then the parent removes the Telegram row (e.g., changes type to slack).
    // The pending callback must reflect that the token is dropped, not leak it.
    const onPendingChange = vi.fn<(creds: CredentialDraft) => void>()
    const { rerender } = render(
      <ToastProvider>
        <ChannelCredentialsPanel
          ccName="cc-prune"
          pending={true}
          onPendingChange={onPendingChange}
          visibleChannelTypes={['telegram']}
        />
      </ToastProvider>
    )

    // User types a Telegram token.
    act(() => {
      fireEvent.change(screen.getByLabelText('Telegram Bot Token'), {
        target: { value: '123:abc' },
      })
    })
    expect(onPendingChange).toHaveBeenLastCalledWith({ 'telegram-bot-token': '123:abc' })

    // Parent removes Telegram from visible types → panel drops the cached value.
    rerender(
      <ToastProvider>
        <ChannelCredentialsPanel
          ccName="cc-prune"
          pending={true}
          onPendingChange={onPendingChange}
          visibleChannelTypes={['slack']}
        />
      </ToastProvider>
    )
    expect(onPendingChange).toHaveBeenLastCalledWith({})
  })
})
