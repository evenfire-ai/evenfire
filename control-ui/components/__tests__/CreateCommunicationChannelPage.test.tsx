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
 * - provider setup uses a Telegram/Slack/Teams segmented selector with provider-scoped credentials
 * - route fields are absent because conversations are confirmed from Profile UI
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import CreateCommunicationChannelPage from '../../app/communication-channels/new/page'
import * as api from '../../lib/api'

const mockNavigation = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}))
const mockPush = mockNavigation.push
const mockSearchParams = mockNavigation.searchParams

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
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

beforeEach(() => {
  Array.from(mockSearchParams.keys()).forEach(key => mockSearchParams.delete(key))
  vi.mocked(api.apiGet).mockResolvedValue({ items: [{ metadata: { name: 'agent-a' } }] })
  vi.mocked(api.apiSend).mockResolvedValue({})
  vi.mocked(api.getAgentTeams).mockResolvedValue({ items: [] })
  vi.mocked(api.getAgentUsers).mockResolvedValue({ items: [] })
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
  fireEvent.click(screen.getByRole('radio', { name: 'Telegram' }))
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

    expect(
      screen.getByRole('radiogroup', { name: 'Communication channel provider' })
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Telegram' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Slack' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Email' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Telegram Bot Token')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('@your_bot')).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: /answer only when the bot is mentioned/i })
    ).toBeChecked()
    expect(screen.queryByLabelText('Slack Signing Secret')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /telegram chat type/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Telegram channel ID/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))
    expect(
      screen.getByRole('checkbox', { name: /answer only when the app is mentioned/i })
    ).toBeChecked()
    expect(screen.getByLabelText('Slack Signing Secret')).toBeInTheDocument()
    expect(screen.getByLabelText('Slack Bot User OAuth Token')).toBeInTheDocument()
    expect(screen.queryByLabelText('Telegram Bot Token')).not.toBeInTheDocument()
  })

  it('shows a Teams bot create command using generated .env labels and channel endpoint', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    expect(
      screen.getByRole('checkbox', { name: /answer only when the bot is mentioned/i })
    ).toBeChecked()

    const botNameInput = screen.getByLabelText(/^Name/)
    fireEvent.change(botNameInput, {
      target: { value: 'Evenfire Bot!' },
    })

    expect(botNameInput).toHaveValue('evenfire-bot')
    expect(
      screen.getByText(/The command writes generated Teams bot values into/i)
    ).toBeInTheDocument()
    expect(screen.getByText('Upload and download files')).toBeInTheDocument()

    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('teams app create')
    expect(command).toHaveTextContent('--name "evenfire-bot"')
    expect(command).toHaveTextContent('/webhooks/teams/')
    expect(command).toHaveTextContent('--env .env')
    expect(screen.getByLabelText(/^CLIENT_ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^TENANT_ID/)).toBeInTheDocument()
    expect(screen.getByLabelText('CLIENT_SECRET')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeEnabled()
  })

  it('validates Teams CLIENT_ID and TENANT_ID before submission', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'evenfire-bot' },
    })
    fireEvent.change(screen.getByLabelText('CLIENT_SECRET'), {
      target: { value: 'secret' },
    })
    fireEvent.change(screen.getByLabelText(/^CLIENT_ID/), {
      target: { value: 'not-a-uuid' },
    })
    fireEvent.change(screen.getByLabelText(/^TENANT_ID/), {
      target: { value: '21e08d37-8d53-4144-87cb-557b8298aed3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    expect(await screen.findByText('CLIENT_ID must be a valid UUID.')).toBeInTheDocument()
    expect(api.apiSend).not.toHaveBeenCalled()
  })

  it('submits Teams settings and credentials with UUID values', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'evenfire-bot' },
    })
    fireEvent.change(screen.getByLabelText(/^CLIENT_ID/), {
      target: { value: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82' },
    })
    fireEvent.change(screen.getByLabelText(/^TENANT_ID/), {
      target: { value: '21e08d37-8d53-4144-87cb-557b8298aed3' },
    })
    fireEvent.change(screen.getByLabelText('CLIENT_SECRET'), {
      target: { value: 'secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(api.apiSend).toHaveBeenCalled())
    expect(api.apiSend).toHaveBeenCalledWith(
      'POST',
      '/api/v1/admin/communication-channels',
      expect.objectContaining({
        metadata: { name: 'my-channel' },
        spec: expect.objectContaining({
          hostRef: 'agent-a',
          teamsSettings: {
            appName: 'evenfire-bot',
            appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
            tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            replyOnlyWhenMentioned: true,
          },
        }),
        credentials: { 'teams-app-password': 'secret' },
      })
    )
  })

  it('prefills copied access and agent while creating the selected provider', async () => {
    mockSearchParams.set('copyFrom', 'source-channel')
    mockSearchParams.set('provider', 'slack')
    vi.mocked(api.getAgentTeams).mockResolvedValue({
      items: [{ id: 'team-a', name: 'Team A' }],
    })
    vi.mocked(api.getAgentUsers).mockResolvedValue({
      items: [
        {
          id: 'user-a',
          email: 'user-a@example.com',
          name: 'User A',
          displayName: 'User A',
        },
      ],
    })
    vi.mocked(api.apiGet).mockImplementation(async path => {
      if (path === '/api/v1/admin/hosts') {
        return { items: [{ metadata: { name: 'agent-a' } }] }
      }
      if (path === '/api/v1/admin/communication-channels/source-channel') {
        return {
          metadata: { name: 'source-channel' },
          spec: {
            access: {
              teams: ['team-a'],
              users: ['user-a'],
            },
            hostRef: 'agent-a',
            telegram: [],
            telegramSettings: {
              botHandle: '@source_bot',
              replyOnlyWhenMentioned: true,
            },
          },
        }
      }
      return { items: [] }
    })

    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /agent reference/i })).toHaveTextContent('agent-a')
    })
    expect(screen.getByPlaceholderText(/channel-name/i)).toHaveValue('')

    fireEvent.change(screen.getByPlaceholderText(/channel-name/i), {
      target: { value: 'copied-channel' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const slackOption = await screen.findByRole('radio', { name: 'Slack' })
    expect(slackOption).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Members (1)' })).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Your Slack App'), {
      target: { value: 'Evenfire Test App' },
    })
    fireEvent.change(screen.getByLabelText('Slack Signing Secret'), {
      target: { value: 'signing-secret' },
    })
    fireEvent.change(screen.getByLabelText('Slack Bot User OAuth Token'), {
      target: { value: 'xoxb-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalled()
    })

    const [, , body] = vi.mocked(api.apiSend).mock.calls[0] as [
      string,
      string,
      {
        spec: {
          access: { teams: string[]; users: string[] }
          hostRef: string
          slackSettings?: { botHandle?: string }
        }
      },
    ]
    expect(body.spec.hostRef).toBe('agent-a')
    expect(body.spec.access).toEqual({ teams: ['team-a'], users: ['user-a'] })
    expect(body.spec.slackSettings?.botHandle).toBe('Evenfire Test App')
  })
})

/**
 * The cold start: a Slack channel cannot be created without a bot token, and the
 * bot token does not exist until a Slack app has been installed — but installing
 * one needs the scopes, the five events, and both Request URLs, none of which the
 * create page offered. The manifest carries all of it, and the Request URL is
 * derivable from the channel name alone, so it can be handed over here rather
 * than only after the channel exists.
 */
describe('CreateCommunicationChannelPage — Slack app manifest', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function decodeSlackTarget(manifestYaml: string): unknown {
    const match = manifestYaml.match(/\/webhooks\/slack\/slack%3A([A-Za-z0-9_-]+)/)
    if (!match) throw new Error(`no slack target id in manifest:\n${manifestYaml}`)
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(b64, 'base64').toString())
  }

  async function goToSlackProviderStep(rawName: string) {
    await waitFor(() => {
      expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument()
    })
    fireEvent.change(screen.getByPlaceholderText(/channel-name/i), {
      target: { value: rawName },
    })
    fireEvent.click(screen.getByRole('button', { name: /agent reference/i }))
    fireEvent.click(screen.getByRole('option', { name: 'agent-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('button', { name: 'Create channel' })
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))
  }

  it('offers a manifest on the create page, before any channel exists', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )
    await goToSlackProviderStep('support-bot')
    fireEvent.change(document.getElementById('slack-bot-handle')!, {
      target: { value: 'Evenfire' },
    })

    const manifest = await screen.findByText(/display_information:/)
    // Both Request URLs, because setting only Event Subscriptions is what leaves
    // approval buttons dead with nothing in the logs.
    expect(manifest.textContent?.match(/request_url:/g) ?? []).toHaveLength(2)
    expect(manifest.textContent).toContain('https://webhook.example.com/webhooks/slack/')
  })

  it('points the Request URL at the channel the create actually writes', async () => {
    // The manifest is handed over BEFORE the channel exists, so the one thing that
    // can silently go wrong is the URL naming a channel the save never creates —
    // the wrong-Request-URL failure this whole manifest was written to remove.
    // Pinning the manifest against the POST body is what makes them impossible to
    // drift apart; asserting a hardcoded name would only restate the fixture.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )
    await goToSlackProviderStep('My Support Bot')
    fireEvent.change(document.getElementById('slack-bot-handle')!, {
      target: { value: 'Evenfire' },
    })

    const manifest = await screen.findByText(/display_information:/)
    const encoded = decodeSlackTarget(manifest.textContent ?? '') as {
      namespace: string
      name: string
    }

    fireEvent.change(screen.getByLabelText('Slack Signing Secret'), {
      target: { value: 'signing-secret' },
    })
    fireEvent.change(screen.getByLabelText('Slack Bot User OAuth Token'), {
      target: { value: 'xoxb-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))
    await waitFor(() => {
      expect(api.apiSend).toHaveBeenCalled()
    })

    const [, , body] = vi.mocked(api.apiSend).mock.calls[0] as [
      string,
      string,
      { metadata: { name: string } },
    ]
    expect(encoded.name).toBe(body.metadata.name)
    expect(encoded.namespace).toBe('channels')
  })

  it('links straight to Slack app creation, in a new tab', async () => {
    // The manifest is only useful next to the page that consumes it, and that page
    // is a different site. Sending the operator to find it themselves is the step
    // this whole panel exists to remove. New tab, because the half-filled create
    // form must survive the trip.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )
    await goToSlackProviderStep('support-bot')
    fireEvent.change(document.getElementById('slack-bot-handle')!, {
      target: { value: 'Evenfire' },
    })
    await screen.findByText(/display_information:/)

    const link = screen.getByRole('link', { name: /create.*slack app/i })
    expect(link).toHaveAttribute('href', 'https://api.slack.com/apps?new_app=1')
    expect(link).toHaveAttribute('target', '_blank')
    // Untrusted target: never hand it a live window.opener back to this form.
    expect(link.getAttribute('rel') ?? '').toMatch(/noreferrer|noopener/)
  })

  it('warns that Slack will report the Request URL as unreachable until the channel exists', async () => {
    // Inherent to handing the manifest over first: the reader authorises a Slack
    // request by resolving the target channel's signing secret BEFORE answering
    // the url_verification challenge, so a URL naming a channel that does not
    // exist yet cannot verify. Slack shows "Your URL didn't respond" in orange the
    // moment the manifest is saved, which reads as a broken setup unless the page
    // says otherwise, and the fix is a Retry once the channel is created.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )
    await goToSlackProviderStep('support-bot')
    fireEvent.change(document.getElementById('slack-bot-handle')!, {
      target: { value: 'Evenfire' },
    })
    await screen.findByText(/display_information:/)

    const panel = document.querySelector('.cu-channel-provider-panel')
    const copy = panel?.textContent ?? ''
    // Either apostrophe: the copy uses a typographic one, and which glyph it is
    // has nothing to do with whether the warning is present.
    expect(copy).toMatch(/did(?:n['’]t| not) respond|unreachable/i)
    expect(copy).toMatch(/Retry/i)
  })

  it('offers no manifest until the Slack App Name is set', async () => {
    // The app name is the manifest's display_information.name. Emitting one with a
    // placeholder would install an app under a name the operator never chose.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )
    await goToSlackProviderStep('support-bot')

    expect(screen.queryByText(/display_information:/)).not.toBeInTheDocument()
  })
})
