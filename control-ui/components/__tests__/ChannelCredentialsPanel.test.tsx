import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChannelCredentialsPanel } from '../ChannelCredentialsPanel'
import type { CredentialDraft } from '../ChannelCredentialsPanel/types'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** What a field with a stored value renders. Copied from the panel, not imported,
 *  so a change to the mask has to be looked at here too. */
const MASKED = '**********'
/** Placeholder shown while the stored-key list is unknown (GET in flight). */
const PENDING_PLACEHOLDER = 'Checking stored credentials…'

function credentialInput(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

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

describe('ChannelCredentialsPanel — per-key stored state', () => {
  const TELEGRAM_AND_SLACK: Parameters<typeof ChannelCredentialsPanel>[0] = {
    ccName: 'jose-tg',
    visibleChannelTypes: ['telegram', 'slack'],
  }

  it('masks only the keys the Secret actually holds', () => {
    // The regression: a Telegram-only Secret used to mask every field, so an
    // operator read "Slack is configured here" off a channel that had no Slack
    // credential at all.
    renderPanel({ ...TELEGRAM_AND_SLACK, storedKeys: ['telegram-bot-token'] })

    expect(credentialInput('Telegram Bot Token').value).toBe(MASKED)

    const signingSecret = credentialInput('Slack Signing Secret')
    expect(signingSecret.value).not.toBe(MASKED)
    expect(signingSecret.value).toBe('')
    expect(signingSecret.placeholder).toBe('signing secret')

    const botToken = credentialInput('Slack Bot User OAuth Token')
    expect(botToken.value).not.toBe(MASKED)
    expect(botToken.value).toBe('')
    expect(botToken.placeholder).toBe('xoxb-…')
  })

  it('renders every field empty and rotatable when the Secret holds nothing', () => {
    renderPanel({ ...TELEGRAM_AND_SLACK, storedKeys: [] })

    for (const [label, placeholder] of [
      ['Telegram Bot Token', '123456789:ABCDEF…'],
      ['Slack Signing Secret', 'signing secret'],
      ['Slack Bot User OAuth Token', 'xoxb-…'],
    ] as const) {
      const input = credentialInput(label)
      expect(input.value).toBe('')
      expect(input.placeholder).toBe(placeholder)
      expect(input.getAttribute('aria-busy')).toBe(null)
      expect(screen.getByLabelText(`Edit ${label}`)).not.toBeDisabled()
      // Nothing stored under this key, so there is nothing to delete.
      expect(screen.getByLabelText(`Delete ${label}`)).toBeDisabled()
    }
  })

  it('renders a pending state, not the empty state, while the key list is unknown', () => {
    renderPanel({ ...TELEGRAM_AND_SLACK, storedKeys: undefined })

    for (const label of [
      'Telegram Bot Token',
      'Slack Signing Secret',
      'Slack Bot User OAuth Token',
    ]) {
      const input = credentialInput(label)
      expect(input.getAttribute('aria-busy')).toBe('true')
      expect(input.placeholder).toBe(PENDING_PLACEHOLDER)
      expect(input.value).toBe('')
      // Editing a field whose stored state is unknown would be discarded the
      // moment the answer lands, so the controls stay closed until it does.
      expect(screen.getByLabelText(`Edit ${label}`)).toBeDisabled()
      expect(screen.getByLabelText(`Delete ${label}`)).toBeDisabled()
    }
    // The empty state's own placeholders must not appear while pending.
    expect(credentialInput('Slack Signing Secret').placeholder).not.toBe('signing secret')
  })

  it('re-syncs a field when a rotation adds its key to the stored list', () => {
    const { rerender } = render(
      <ToastProvider>
        <ChannelCredentialsPanel
          ccName="jose-tg"
          visibleChannelTypes={['telegram', 'slack']}
          storedKeys={['telegram-bot-token']}
        />
      </ToastProvider>
    )

    // Operator opens the Slack bot token for editing and types a value.
    act(() => {
      fireEvent.click(screen.getByLabelText('Edit Slack Bot User OAuth Token'))
    })
    act(() => {
      fireEvent.change(credentialInput('Slack Bot User OAuth Token'), {
        target: { value: 'xoxb-typed-but-never-saved' },
      })
    })
    expect(credentialInput('Slack Bot User OAuth Token').value).toBe('xoxb-typed-but-never-saved')

    // The parent re-reads the Secret and the key now exists (rotated elsewhere).
    rerender(
      <ToastProvider>
        <ChannelCredentialsPanel
          ccName="jose-tg"
          visibleChannelTypes={['telegram', 'slack']}
          storedKeys={['telegram-bot-token', 'slack-bot-token']}
        />
      </ToastProvider>
    )

    expect(credentialInput('Slack Bot User OAuth Token').value).toBe(MASKED)
    expect(credentialInput('Telegram Bot Token').value).toBe(MASKED)
    expect(credentialInput('Slack Signing Secret').value).toBe('')
  })

  it('keeps a typed value when the parent passes an equal key list in a new array', () => {
    // The parent re-renders for unrelated reasons and hands over a fresh array
    // with the same contents. Keying the reset on array identity would wipe
    // what the operator is halfway through typing.
    const { rerender } = render(
      <ToastProvider>
        <ChannelCredentialsPanel
          ccName="jose-tg"
          visibleChannelTypes={['slack']}
          storedKeys={['slack-signing-secret', 'telegram-bot-token']}
        />
      </ToastProvider>
    )

    act(() => {
      fireEvent.click(screen.getByLabelText('Edit Slack Bot User OAuth Token'))
    })
    act(() => {
      fireEvent.change(credentialInput('Slack Bot User OAuth Token'), {
        target: { value: 'xoxb-half-typed' },
      })
    })

    rerender(
      <ToastProvider>
        <ChannelCredentialsPanel
          ccName="jose-tg"
          visibleChannelTypes={['slack']}
          storedKeys={['telegram-bot-token', 'slack-signing-secret']}
        />
      </ToastProvider>
    )

    expect(credentialInput('Slack Bot User OAuth Token').value).toBe('xoxb-half-typed')
  })

  it('masks a key it just saved even though the parent list is now stale', () => {
    renderPanel({ ...TELEGRAM_AND_SLACK, storedKeys: ['telegram-bot-token'] })

    act(() => {
      fireEvent.click(screen.getByLabelText('Edit Slack Signing Secret'))
    })
    act(() => {
      fireEvent.change(credentialInput('Slack Signing Secret'), {
        target: { value: 'signing-secret-value' },
      })
    })
    act(() => {
      fireEvent.click(screen.getByLabelText('Save Slack Signing Secret'))
    })

    return waitFor(() => {
      expect(credentialInput('Slack Signing Secret').value).toBe(MASKED)
    })
  })

  it('renders masked read-only fields only for keys that exist', () => {
    renderPanel({
      ...TELEGRAM_AND_SLACK,
      readOnly: true,
      storedKeys: ['slack-bot-token'],
    })

    expect(credentialInput('Slack Bot User OAuth Token').value).toBe(MASKED)
    expect(credentialInput('Slack Signing Secret').value).toBe('')
    expect(credentialInput('Telegram Bot Token').value).toBe('')
    expect(screen.queryByLabelText('Edit Slack Bot User OAuth Token')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Delete Slack Bot User OAuth Token')).not.toBeInTheDocument()
  })

  it('ignores storedKeys in pending (create) mode', () => {
    // A CC that does not exist yet has no Secret to report on; the panel must
    // stay a plain editable form even if a caller passes a list.
    renderPanel({
      ccName: 'cc-new',
      pending: true,
      visibleChannelTypes: ['slack'],
      storedKeys: ['slack-signing-secret'],
    })

    const signingSecret = credentialInput('Slack Signing Secret')
    expect(signingSecret.value).toBe('')
    expect(signingSecret.placeholder).toBe('signing secret')
    expect(signingSecret).not.toBeDisabled()
  })
})
