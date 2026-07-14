/**
 * B5 namespace-honesty: asserts that CreateCommunicationChannelPage
 * - no longer renders a Namespace text input
 * - does not include `metadata.namespace` in the POST body
 *
 * B6 credential save confirmation / error surface:
 * - success path shows a success toast
 * - API 400 (credentials-required) surfaces the specific error message via StatusBanner
 *
 * Create polish:
 * - provider setup uses Telegram and Slack tabs with provider-scoped credentials
 * - route fields are absent because conversations are confirmed from Profile UI
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import CreateCommunicationChannelPage from '../../app/communication-channels/new/page'
import * as api from '../../lib/api'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    apiGet: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'agent-a' } }] }),
    apiSend: vi.fn().mockResolvedValue({}),
    getAgentTeams: vi.fn().mockResolvedValue({ items: [] }),
    getAgentUsers: vi.fn().mockResolvedValue({ items: [] }),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** Shared helper: fill step 1 and advance to step 2. */
async function fillStep1AndContinue() {
  await waitFor(() => {
    expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument()
  })
  fireEvent.change(screen.getByPlaceholderText(/channel-name/i), {
    target: { value: 'my-channel' },
  })
  fireEvent.click(screen.getByRole('button', { name: /agent reference/i }))
  fireEvent.click(screen.getByRole('option', { name: 'agent-a' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('button', { name: 'Create channel' })
}

function selectTelegramAndToken() {
  fireEvent.click(screen.getByRole('tab', { name: 'Telegram' }))
  fireEvent.change(screen.getByPlaceholderText('@your_bot'), {
    target: { value: '@clerum_test_bot' },
  })
  fireEvent.change(screen.getByLabelText('Telegram Bot Token'), {
    target: { value: '123456789:ABCDEF' },
  })
}

describe('CreateCommunicationChannelPage — B5 namespace honesty', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  it('does not render a Namespace input field', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    // Wait for the hosts to load so the form is fully initialised
    await waitFor(() => {
      expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument()
    })

    // There must be no field labelled "Namespace" on the form
    expect(screen.queryByLabelText('Namespace')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /namespace/i })).not.toBeInTheDocument()
  })

  it('POST body does not include metadata.namespace', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    selectTelegramAndToken()

    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalled()
    })

    const [, , body] = vi.mocked(api.apiSend).mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(body).toHaveProperty('metadata')
    const metadata = body.metadata as Record<string, unknown>
    expect(metadata).not.toHaveProperty('namespace')
    expect(metadata).toHaveProperty('name', 'my-channel')
  })
})

describe('CreateCommunicationChannelPage — B6 credential save confirmation / error surface', () => {
  beforeEach(() => {
    mockPush.mockClear()
    vi.mocked(api.apiSend).mockResolvedValue({})
  })

  it('shows a success toast after the channel is created', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    selectTelegramAndToken()
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Communication channel created.')
    })
  })

  it('surfaces the specific API error message when the POST fails (e.g. credentials required)', async () => {
    vi.mocked(api.apiSend).mockRejectedValue(
      new Error(
        '400 Bad Request - A CommunicationChannel with a provider (telegram, slack, or email) requires credentials.'
      )
    )

    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    selectTelegramAndToken()
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => {
      // The cu-banner--error should contain the specific API message, not a generic one
      expect(screen.getByText(/requires credentials/i)).toBeInTheDocument()
    })
    // No navigation on error
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('CreateCommunicationChannelPage — provider setup', () => {
  beforeEach(() => {
    mockPush.mockClear()
    vi.mocked(api.apiSend).mockResolvedValue({})
  })

  it('shows provider-scoped credentials without route or Email controls', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()

    expect(screen.getByRole('tab', { name: 'Telegram' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Slack' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Email' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Telegram Bot Token')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('@your_bot')).toBeInTheDocument()
    expect(screen.queryByLabelText('Slack Signing Secret')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /telegram chat type/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Telegram channel ID/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Slack' }))
    expect(screen.getByLabelText('Slack Signing Secret')).toBeInTheDocument()
    expect(screen.getByLabelText('Slack Bot User OAuth Token')).toBeInTheDocument()
    expect(screen.queryByLabelText('Telegram Bot Token')).not.toBeInTheDocument()
  })
})
