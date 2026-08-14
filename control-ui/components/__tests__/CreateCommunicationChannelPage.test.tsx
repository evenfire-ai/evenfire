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

  afterEach(() => {
    vi.unstubAllEnvs()
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
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
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
      target: { value: 'Evenfire Bot' },
    })

    // appName is a free-form display name on both the CRD and control-api, and
    // the Teams CLI documents --name the same way, so what the operator types
    // is what the command must carry.
    expect(botNameInput).toHaveValue('Evenfire Bot')
    expect(
      screen.getByText(/The command writes CLIENT_ID, TENANT_ID and CLIENT_SECRET into/i)
    ).toBeInTheDocument()
    // supportsFiles is a manifest property, not a Developer Portal toggle. The
    // panel used to point at a checkbox the current portal does not present.
    expect(screen.getByText(/bots\[0\]\.supportsFiles=true/)).toBeInTheDocument()
    expect(screen.getByText(/direct chat only, not in a channel/i)).toBeInTheDocument()

    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('teams app create')
    // Quoted, so a display name with a space stays one argument.
    expect(command).toHaveTextContent('--name "Evenfire Bot"')
    expect(command).toHaveTextContent('--endpoint "https://webhook.example.com/webhooks/teams/')
    // channel-reader uses a tenant-scoped token URL, so a multi-tenant app fails
    // with AADSTS. The CLI does not document its default, so the flag is pinned.
    expect(command).toHaveTextContent('--sign-in-audience myOrg')
    expect(command).toHaveTextContent('--env .env')
    expect(screen.getByLabelText(/^CLIENT_ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^TENANT_ID/)).toBeInTheDocument()
    expect(screen.getByLabelText('CLIENT_SECRET')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeEnabled()
  })

  // The list used to narrate three steps and then drop both commands after it, so
  // "run this" in step 1 pointed past step 3 at a block that was not even the
  // command step 3 talked about. Each command now sits in the step that means it.
  it('puts each Teams command inside the step that tells you to run it', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Evenfire Bot' } })

    const steps = screen.getByText(/Run this from any directory/i).closest('ol')
    const items = Array.from(steps?.querySelectorAll(':scope > li') ?? [])
    expect(items).toHaveLength(3)

    expect(items[0].querySelector('pre')).toHaveTextContent('teams app create')
    expect(items[1].querySelector('pre')).toBeNull()
    expect(items[2].querySelector('pre')).toHaveTextContent(
      "teams app manifest update <appId> --set-json 'bots[0].supportsFiles=true' --yes"
    )
  })

  // Inline <code> is not copyable, and this command is the one with the trap in it.
  it('makes the file support command copyable and fills in CLIENT_ID once pasted', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))

    expect(
      screen.getByRole('button', { name: 'Copy Teams file support command' })
    ).toBeInTheDocument()

    // On a teams-managed bot the app id IS CLIENT_ID, so the placeholder resolves
    // to a command that can be run as copied.
    fireEvent.change(screen.getByLabelText(/^CLIENT_ID/), {
      target: { value: '11111111-2222-3333-4444-555555555555' },
    })
    expect(
      screen.getByText(
        "teams app manifest update 11111111-2222-3333-4444-555555555555 --set-json 'bots[0].supportsFiles=true' --yes"
      )
    ).toBeInTheDocument()
  })

  it('warns and still renders a placeholder-origin command when the deployment has no public webhook origin', async () => {
    // No NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL and jsdom's hostname is
    // localhost (not app.*), which is the minikube case. The endpoint the CLI
    // would need is a bare path here, and registering a Teams bot against a
    // bare path points it at a host that does not exist -- but leaving the
    // operator with nothing to run is worse: the documented minikube workflow
    // is to substitute a real origin for the placeholder by hand, so the
    // command still renders, built from the marker origin.
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'Evenfire Bot' },
    })

    const panel = document.querySelector('.cu-channel-provider-panel')
    expect(panel?.textContent ?? '').toMatch(
      /NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL|no public webhook origin/i
    )

    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('--name "Evenfire Bot"')
    // Pin the literal placeholder origin: this is what the operator is being
    // told to replace by hand.
    expect(command).toHaveTextContent('--endpoint "https://<public-webhook-origin>/webhooks/teams/')
    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeEnabled()
  })

  it('treats an http webhook origin as unusable, since Microsoft requires https', async () => {
    // Microsoft needs a publicly reachable HTTPS messaging endpoint, so an http
    // origin has to land in the warning branch -- and that branch must still
    // render a usable command, not the marker origin glued onto an absolute
    // http URL.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'http://webhook.example.com')
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Evenfire Bot' } })

    const panel = document.querySelector('.cu-channel-provider-panel')
    expect(panel?.textContent ?? '').toMatch(/no public webhook origin/i)

    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('--endpoint "https://<public-webhook-origin>/webhooks/teams/')
    expect(command?.textContent ?? '').not.toContain('http://webhook.example.com')
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

  it('requires a Teams bot name before submitting', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText('CLIENT_SECRET'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/^CLIENT_ID/), {
      target: { value: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82' },
    })
    fireEvent.change(screen.getByLabelText(/^TENANT_ID/), {
      target: { value: '21e08d37-8d53-4144-87cb-557b8298aed3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    // The name is free-form, but it is not optional: control-api rejects an
    // appName that is present and empty, and the whole setup command is built
    // around it.
    expect(await screen.findByText('Teams bot name is required.')).toBeInTheDocument()
    expect(api.apiSend).not.toHaveBeenCalled()
  })

  it('rejects a Teams bot name past the 80 character server limit', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'a'.repeat(81) } })
    fireEvent.change(screen.getByLabelText('CLIENT_SECRET'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/^CLIENT_ID/), {
      target: { value: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82' },
    })
    fireEvent.change(screen.getByLabelText(/^TENANT_ID/), {
      target: { value: '21e08d37-8d53-4144-87cb-557b8298aed3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    expect(
      await screen.findByText('Teams bot name must be 80 characters or fewer.')
    ).toBeInTheDocument()
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
      target: { value: 'Evenfire Bot' },
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
            // Persisted exactly as typed: no kebab-casing on the way to the spec.
            appName: 'Evenfire Bot',
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

  it('explains itself when the deployment has no public webhook address', async () => {
    // Minikube and localhost: no env var and a non-app.* hostname, so
    // webhookUrlForPath returns a bare path and no manifest can be generated. The
    // edit page shows a warning naming the missing variable; rendering nothing
    // here leaves the operator following a doc that promises a manifest, with no
    // cause shown anywhere. jsdom's hostname is localhost, so simply not stubbing
    // the env reproduces it.
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )
    await goToSlackProviderStep('support-bot')
    fireEvent.change(document.getElementById('slack-bot-handle')!, {
      target: { value: 'Evenfire' },
    })

    expect(screen.queryByText(/display_information:/)).not.toBeInTheDocument()
    const panel = document.querySelector('.cu-channel-provider-panel')
    expect(panel?.textContent ?? '').toMatch(
      /NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL|no public webhook address/i
    )
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

describe('CreateCommunicationChannelPage — Teams CLI instruction', () => {
  it('does not tell the operator to run the command from a Teams CLI project directory', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))

    // Absence of old sentence
    expect(screen.queryByText(/project directory that has the Teams CLI project/i)).toBeNull()
    // Presence of new sentence confirms the Teams instruction panel renders
    expect(
      screen.getByText(
        /Run this from any directory. The command writes CLIENT_ID, TENANT_ID and CLIENT_SECRET into/i
      )
    ).toBeInTheDocument()
  })
})

/**
 * An operator without an authenticated Teams CLI, or without a tenant that
 * permits sideloading, used to hit both assumptions unannounced, only after
 * copying the `teams app create` command. The prerequisites block exists to
 * surface both before that command, and to point at the full guide.
 */
describe('CreateCommunicationChannelPage — Teams prerequisites', () => {
  const TEAMS_GUIDE_URL =
    'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/connect-teams.md'

  it('shows CLI install/login and the sideloading check before the Teams provider is selected', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))

    expect(screen.getByText(/npm install -g @microsoft\/teams\.cli/)).toBeInTheDocument()
    expect(screen.getByText('teams login')).toBeInTheDocument()
    expect(screen.getByText('Sideloading: enabled')).toBeInTheDocument()
    // The point of running `teams status` at all: it proves both prerequisites
    // in one shot, and a disabled result means propagation, not breakage.
    expect(screen.getByText(/proves both prerequisites/i)).toBeInTheDocument()
    expect(screen.getByText(/not that anything is broken/i)).toBeInTheDocument()
  })

  it('links to the Teams setup guide', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()
    fireEvent.click(screen.getByRole('radio', { name: 'Microsoft Teams' }))

    const link = screen.getByRole('link', { name: /Teams setup guide/i })
    expect(link).toHaveAttribute('href', TEAMS_GUIDE_URL)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('does not show the Teams prerequisites on the Telegram provider', async () => {
    render(
      <ToastProvider>
        <CreateCommunicationChannelPage />
      </ToastProvider>
    )

    await fillStep1AndContinue()

    expect(screen.queryByText('Sideloading: enabled')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Teams setup guide/i })).not.toBeInTheDocument()
  })
})
