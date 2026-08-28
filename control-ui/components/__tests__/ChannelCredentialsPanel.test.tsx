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
/** Placeholder shown per field once that GET has failed. */
const UNKNOWN_PLACEHOLDER = 'Stored value unknown'
/** Banner copy for a failed stored-key read. Written out, not imported: this
 *  copy is the whole fix, so a reworded panel has to fail here. */
const STORED_KEYS_ERROR =
  'Could not check which credentials are stored. You can still rotate a value; deleting one needs a successful read.'

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

  it('keeps the create wizard editable when no stored-key list is passed', () => {
    // What the create page actually renders: pending, and no storedKeys at all
    // (there is no Secret to read yet). Without the `!pending` guard on
    // keysPending, every credential input on the create page is disabled under
    // a "checking" placeholder for a request nobody made — and no suite
    // notices, because the test that looks like it covers pending mode passes
    // storedKeys, which makes the guard irrelevant to its assertions.
    renderPanel({ ccName: 'cc-new', pending: true, visibleChannelTypes: ['slack'] })

    const signingSecret = credentialInput('Slack Signing Secret')
    // Asserted on the property, not by typing: fireEvent.change dispatches
    // straight at the node and lands on a disabled input just the same.
    expect(signingSecret.disabled).toBe(false)
    expect(signingSecret.placeholder).toBe('signing secret')
    expect(signingSecret.getAttribute('aria-busy')).toBe(null)

    const botToken = credentialInput('Slack Bot User OAuth Token')
    expect(botToken.disabled).toBe(false)
    expect(botToken.placeholder).toBe('xoxb-…')
    expect(botToken.getAttribute('aria-busy')).toBe(null)
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

describe('ChannelCredentialsPanel — failed stored-key read', () => {
  const TELEGRAM_AND_SLACK: Parameters<typeof ChannelCredentialsPanel>[0] = {
    ccName: 'jose-tg',
    visibleChannelTypes: ['telegram', 'slack'],
  }

  it('says the read failed, keeps rotation open, and keeps delete closed', () => {
    // A failed read is NOT the pending state. Rendering it as pending disabled
    // every input, Edit and Delete permanently, under a placeholder describing
    // a request that had already finished, with nothing on screen saying so and
    // no way out but a page reload.
    const onRetryStoredKeys = vi.fn()
    renderPanel({
      ...TELEGRAM_AND_SLACK,
      storedKeys: undefined,
      storedKeysError: 'secrets is forbidden',
      onRetryStoredKeys,
    })

    expect(screen.getByText(STORED_KEYS_ERROR)).toBeInTheDocument()
    // The cause, not just "something went wrong".
    expect(screen.getByText('secrets is forbidden')).toBeInTheDocument()

    for (const label of [
      'Telegram Bot Token',
      'Slack Signing Secret',
      'Slack Bot User OAuth Token',
    ]) {
      const input = credentialInput(label)
      expect(input.getAttribute('aria-busy')).toBe(null)
      expect(input.placeholder).toBe(UNKNOWN_PLACEHOLDER)
      expect(input.value).toBe('')
      // Rotation is a blind PUT: it overwrites whatever is there and needs to
      // know nothing about it, so a failed read must not block it.
      expect(screen.getByLabelText(`Edit ${label}`)).not.toBeDisabled()
      // Deleting a key the panel cannot see is a different matter.
      expect(screen.getByLabelText(`Delete ${label}`)).toBeDisabled()
    }
  })

  it('offers a retry that re-runs the read the panel does not own', () => {
    const onRetryStoredKeys = vi.fn()
    renderPanel({
      ...TELEGRAM_AND_SLACK,
      storedKeysError: 'secrets is forbidden',
      onRetryStoredKeys,
    })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(onRetryStoredKeys).toHaveBeenCalledTimes(1)
  })

  it('still reports the failure when the caller offers no retry', () => {
    renderPanel({ ...TELEGRAM_AND_SLACK, storedKeysError: 'secrets is forbidden' })

    expect(screen.getByText(STORED_KEYS_ERROR)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('lets the panel mask a key it saved while the read was failing', () => {
    // The read said nothing, but this panel just wrote this key, so it knows
    // that one exists — and only that one.
    renderPanel({
      ...TELEGRAM_AND_SLACK,
      storedKeysError: 'secrets is forbidden',
      onRetryStoredKeys: vi.fn(),
    })

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
      expect(credentialInput('Slack Bot User OAuth Token').placeholder).toBe(UNKNOWN_PLACEHOLDER)
    })
  })

  it('never shows the read-failed banner in pending (create) mode', () => {
    // A CC that does not exist has no Secret to read, so nothing can have
    // failed to read it.
    renderPanel({
      ccName: 'cc-new',
      pending: true,
      visibleChannelTypes: ['slack'],
      storedKeysError: 'secrets is forbidden',
      onRetryStoredKeys: vi.fn(),
    })

    expect(screen.queryByText(STORED_KEYS_ERROR)).not.toBeInTheDocument()
    const signingSecret = credentialInput('Slack Signing Secret')
    expect(signingSecret.disabled).toBe(false)
    expect(signingSecret.placeholder).toBe('signing secret')
  })
})

/** The Slack note, written out rather than imported: this copy IS the feature,
 *  so a reworded panel must fail here instead of quietly passing. */
const SLACK_CREDENTIAL_NOTE =
  'You do not need the App-Level Token (xapp-) or the Client Secret. Slack offers the xapp- token right beside the xoxb- one, so it is easy to copy the wrong value.'

describe('ChannelCredentialsPanel — Slack credential note', () => {
  it('tells the operator which Slack values are NOT needed', () => {
    // Slack's "app is ready" dialog hands out xoxb- and xapp- side by side, and
    // the Signing Secret sits next to a Client Secret on another page entirely.
    // Without this note the operator pastes the wrong two values.
    renderPanel({ ccName: 'cc-slack', visibleChannelTypes: ['slack'] })
    expect(screen.getByText(SLACK_CREDENTIAL_NOTE)).toBeInTheDocument()
  })

  it('shows the Slack note on the create (pending) panel too', () => {
    renderPanel({ ccName: 'cc-slack-new', pending: true, visibleChannelTypes: ['slack'] })
    expect(screen.getByText(SLACK_CREDENTIAL_NOTE)).toBeInTheDocument()
  })

  it('does not show the Slack note on a panel with no Slack fields', () => {
    renderPanel({ ccName: 'cc-tg', visibleChannelTypes: ['telegram'] })
    expect(screen.queryByText(SLACK_CREDENTIAL_NOTE)).not.toBeInTheDocument()
  })

  it('does not show the Slack note when no provider is selected', () => {
    renderPanel({ ccName: 'cc-empty', visibleChannelTypes: [] })
    expect(screen.queryByText(SLACK_CREDENTIAL_NOTE)).not.toBeInTheDocument()
  })
})

describe('ChannelCredentialsPanel — where the Slack credentials live', () => {
  // Both Slack values are on different pages of the Slack app, and the signing
  // secret is the one people cannot find: it is absent from the "app is ready"
  // dialog that hands over the bot token, so the natural assumption is that the
  // dialog showed everything. Naming the page is the whole value of this hint --
  // asserting on the location, not the phrasing, so copy can be reworded freely.
  /** The hint rendered directly under a given credential input, not the panel note. */
  function hintFor(label: string): string {
    const input = screen.getByLabelText(label, { exact: true })
    const row = input.closest('.cu-field') ?? input.parentElement?.parentElement
    return row?.querySelector('.cu-field__hint')?.textContent ?? ''
  }

  it('names the Slack page holding the signing secret, on the field itself', () => {
    renderPanel({ ccName: 'cc-slack', visibleChannelTypes: ['slack'] })
    // Must be on the field, not only in the panel note below it: the note is a
    // paragraph people skip, and this is the value they cannot locate.
    // "Settings" matters: Slack's sidebar has Basic Information under Settings and
    // a separate Features group, and the path is useless without the group name.
    expect(hintFor('Slack Signing Secret')).toMatch(/Settings\s*(?:→|->|>)\s*Basic Information/i)
  })

  it('warns the signing secret is absent from the post-install dialog', () => {
    renderPanel({ ccName: 'cc-slack', visibleChannelTypes: ['slack'] })
    expect(hintFor('Slack Signing Secret')).toMatch(/dialog|install/i)
  })

  it('names the Slack page holding the bot token, on the field itself', () => {
    renderPanel({ ccName: 'cc-slack', visibleChannelTypes: ['slack'] })
    expect(hintFor('Slack Bot User OAuth Token')).toMatch(/OAuth & Permissions/i)
  })
})
