import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import EditCommunicationChannelPage from '../../app/communication-channels/[name]/edit/page'
import * as api from '../../lib/api'

const navigation = vi.hoisted(() => ({
  params: { name: 'teams-channel' },
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push }),
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
    apiGet: vi.fn(),
    apiSend: vi.fn().mockResolvedValue({}),
    getAgentTeams: vi.fn().mockResolvedValue({ items: [] }),
    getAgentUsers: vi.fn().mockResolvedValue({ items: [] }),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  navigation.params = { name: 'teams-channel' }
})

type ChannelSpec = Record<string, unknown>

function mockChannel(name: string, spec: ChannelSpec, annotations?: Record<string, string>) {
  navigation.params = { name }
  vi.mocked(api.apiGet).mockImplementation(async path => {
    if (path === '/api/v1/admin/hosts') {
      return { items: [{ metadata: { name: 'agent-a' } }] }
    }
    if (path === `/api/v1/admin/communication-channels/${name}`) {
      return {
        item: {
          metadata: { name, namespace: 'channels', ...(annotations ? { annotations } : {}) },
          spec: { access: { users: [], teams: [] }, hostRef: 'agent-a', ...spec },
        },
      }
    }
    return { items: [] }
  })
}

async function renderLoadedPage() {
  render(
    <ToastProvider>
      <EditCommunicationChannelPage />
    </ToastProvider>
  )
  await waitFor(() => {
    expect(screen.queryByText('Loading communication channel...')).not.toBeInTheDocument()
  })
}

const SLACK_CHANNEL_SPEC: ChannelSpec = {
  credentialsSecretRef: { name: 'cc-slack-channel-credentials' },
  slackSettings: { botHandle: 'Evenfire', replyOnlyWhenMentioned: true },
}

/** A Telegram-only channel that still carries a leftover Slack label annotation. */
const LABELLED_TELEGRAM_CHANNEL = 'telegram-labelled'
const LABELLED_TELEGRAM_SPEC: ChannelSpec = {
  telegramSettings: { botHandle: '@ops_bot', replyOnlyWhenMentioned: false },
}
const STALE_SLACK_LABEL = { 'clerum.io/slack-bot-label': 'Evenfire' }
/**
 * The Request URL that channel would get if the gate let an annotation through:
 * base64url of {"namespace":"channels","name":"telegram-labelled"}, which is what
 * the reader decodes. Written out rather than derived so a change to either the
 * gate or the encoding has to be looked at.
 */
const LABELLED_TELEGRAM_REQUEST_URL =
  'https://webhook.example.com/webhooks/slack/slack%3AeyJuYW1lc3BhY2UiOiJjaGFubmVscyIsIm5hbWUiOiJ0ZWxlZ3JhbS1sYWJlbGxlZCJ9'

describe('EditCommunicationChannelPage', () => {
  it('renders Teams setup details and confirmed conversation metadata', async () => {
    vi.mocked(api.apiGet).mockImplementation(async path => {
      if (path === '/api/v1/admin/hosts') {
        return { items: [{ metadata: { name: 'agent-a' } }] }
      }
      if (path === '/api/v1/admin/communication-channels/teams-channel') {
        return {
          item: {
            metadata: { name: 'teams-channel', namespace: 'channels' },
            spec: {
              access: { users: [], teams: [] },
              hostRef: 'agent-a',
              credentialsSecretRef: { name: 'cc-teams-channel-credentials' },
              teamsSettings: {
                appName: 'evenfire',
                appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
                tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
              },
              teams: [
                {
                  channelId: '19:channel@thread.tacv2',
                  tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
                  conversationType: 'channel',
                  title: 'General',
                  confirmedAt: '2026-07-10T12:00:00Z',
                },
              ],
            },
          },
        }
      }
      return { items: [] }
    })

    render(
      <ToastProvider>
        <EditCommunicationChannelPage />
      </ToastProvider>
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading communication channel...')).not.toBeInTheDocument()
    })

    expect(screen.getByText('Teams Request URL')).toBeInTheDocument()
    expect(screen.getByText(/\/webhooks\/teams\//)).toBeInTheDocument()
    expect(screen.getByText('General')).toBeInTheDocument()
    expect(screen.getByText('Channel')).toBeInTheDocument()
  })
})

describe('EditCommunicationChannelPage channel credentials', () => {
  const TELEGRAM_ONLY_CHANNEL = 'jose-tg'
  const TELEGRAM_ONLY_SPEC: ChannelSpec = {
    credentialsSecretRef: { name: 'cc-jose-tg-credentials' },
    telegramSettings: { botHandle: '@ops_bot' },
  }

  /** Like mockChannel, but also answers the per-channel credentials read.
   *  Pass an Error to make that read fail. */
  function mockChannelCredentials(name: string, spec: ChannelSpec, credentials: unknown) {
    navigation.params = { name }
    vi.mocked(api.apiGet).mockImplementation(async path => {
      if (path === '/api/v1/admin/hosts') {
        return { items: [{ metadata: { name: 'agent-a' } }] }
      }
      if (path === `/api/v1/admin/communication-channels/${name}/credentials`) {
        if (credentials instanceof Error) throw credentials
        return credentials
      }
      if (path === `/api/v1/admin/communication-channels/${name}`) {
        return {
          item: {
            metadata: { name, namespace: 'channels' },
            spec: { access: { users: [], teams: [] }, hostRef: 'agent-a', ...spec },
          },
        }
      }
      return { items: [] }
    })
  }

  it('masks only the keys the channel Secret holds, not every field', async () => {
    // The channel has a Secret, but it holds a Telegram token only. Inferring
    // per-field state from the Secret's existence rendered both Slack fields as
    // populated, so a half-configured channel read as configured.
    mockChannelCredentials(TELEGRAM_ONLY_CHANNEL, TELEGRAM_ONLY_SPEC, {
      name: TELEGRAM_ONLY_CHANNEL,
      secretName: 'cc-jose-tg-credentials',
      namespace: 'channels',
      keys: ['telegram-bot-token'],
    })
    await renderLoadedPage()

    await waitFor(() => {
      expect(screen.getByLabelText('Telegram Bot Token')).toHaveValue('**********')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))
    const signingSecret = screen.getByLabelText('Slack Signing Secret') as HTMLInputElement
    expect(signingSecret.value).not.toBe('**********')
    expect(signingSecret.value).toBe('')
    expect(signingSecret.placeholder).toBe('signing secret')
    const botToken = screen.getByLabelText('Slack Bot User OAuth Token') as HTMLInputElement
    expect(botToken.value).toBe('')
    expect(botToken.placeholder).toBe('xoxb-…')
  })

  it('renders no credentials as empty when the Secret holds nothing', async () => {
    mockChannelCredentials(TELEGRAM_ONLY_CHANNEL, TELEGRAM_ONLY_SPEC, {
      name: TELEGRAM_ONLY_CHANNEL,
      secretName: 'cc-jose-tg-credentials',
      namespace: 'channels',
      keys: [],
    })
    await renderLoadedPage()

    await waitFor(() => {
      expect(screen.getByLabelText('Edit Telegram Bot Token')).toBeEnabled()
    })
    const telegramToken = screen.getByLabelText('Telegram Bot Token') as HTMLInputElement
    expect(telegramToken.value).toBe('')
    expect(telegramToken.placeholder).toBe('123456789:ABCDEF…')
  })

  it('leaves the fields unknown, not empty, when the credentials read fails', async () => {
    // A denied or failed read says nothing about what is stored. Rendering the
    // empty state here would report "no credentials" on a channel that has them.
    mockChannelCredentials(
      TELEGRAM_ONLY_CHANNEL,
      TELEGRAM_ONLY_SPEC,
      new Error('secrets is forbidden')
    )
    await renderLoadedPage()

    await waitFor(() => {
      expect(screen.getByLabelText('Telegram Bot Token')).toBeInTheDocument()
    })
    const telegramToken = screen.getByLabelText('Telegram Bot Token') as HTMLInputElement
    expect(telegramToken.getAttribute('aria-busy')).toBe('true')
    expect(telegramToken.value).toBe('')
    expect(telegramToken.placeholder).toBe('Checking stored credentials…')
    // The page itself still loaded: the read failure is scoped to the panel.
    expect(screen.getByLabelText(/Telegram bot handle/)).toHaveValue('@ops_bot')
  })
})

/** Both strings are written out rather than imported: this copy IS the feature,
 *  so a reworded page must fail here instead of quietly passing. */
const EMPTY_CONVERSATIONS_COPY =
  'No conversations confirmed yet. Each user links their own by sending the verify command from their profile page in the conversation they want to link.'
const THREAD_MENTION_COPY =
  'Replies inside a thread still require a mention: even in a thread the app started, a follow-up that does not mention the app is ignored.'

describe('EditCommunicationChannelPage setup guidance', () => {
  it('reads an empty conversation list as the next step, not a broken setup', async () => {
    // A bare "No conversations have been confirmed yet." looks like the channel
    // is broken. Only the end user can confirm one, and nothing on this page
    // used to say so.
    mockChannel('slack-channel', SLACK_CHANNEL_SPEC)
    await renderLoadedPage()

    expect(screen.getByText(EMPTY_CONVERSATIONS_COPY)).toBeInTheDocument()
  })

  it('warns that a thread does not exempt a follow-up from the mention rule', async () => {
    // With "Reply in threads" on, the app answers inside a thread and then
    // ignores every unmentioned follow-up there, which reads as the app
    // breaking mid-conversation.
    mockChannel('slack-channel', SLACK_CHANNEL_SPEC)
    await renderLoadedPage()

    expect(screen.getByText('Answer only when the app is mentioned')).toBeInTheDocument()
    expect(screen.getByText(THREAD_MENTION_COPY)).toBeInTheDocument()
  })

  it('keeps the Slack thread warning off a Telegram channel', async () => {
    mockChannel(LABELLED_TELEGRAM_CHANNEL, LABELLED_TELEGRAM_SPEC, STALE_SLACK_LABEL)
    await renderLoadedPage()

    expect(screen.getByText('Answer only when the bot is mentioned')).toBeInTheDocument()
    expect(screen.queryByText(THREAD_MENTION_COPY)).not.toBeInTheDocument()
  })
})

describe('EditCommunicationChannelPage Slack app manifest', () => {
  it('renders the manifest with both request URLs when the webhook is publicly reachable', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('slack-channel', SLACK_CHANNEL_SPEC)
    await renderLoadedPage()

    expect(screen.getByText('Slack App Manifest')).toBeInTheDocument()

    const manifest = screen.getByText(/display_information:/).textContent ?? ''
    const requestUrlLines = manifest
      .split('\n')
      .filter(line => line.trim().startsWith('request_url:'))
    expect(requestUrlLines).toHaveLength(2)
    expect(new Set(requestUrlLines).size).toBe(1)
    expect(requestUrlLines[0]).toContain('https://webhook.example.com/webhooks/slack/')
    expect(manifest.split('\n').filter(line => /^\s+(name|display_name):/.test(line))).toEqual([
      '  name: "Evenfire"',
      '    display_name: "Evenfire"',
    ])
  })

  it('warns instead of emitting a manifest when the Request URL is only a path', async () => {
    // No NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL and a non-app.* hostname, which is the
    // minikube case. Slack rejects a relative request_url, so a manifest here would be a broken
    // artifact and would send the operator to debug Slack's generic error.
    mockChannel('slack-channel', SLACK_CHANNEL_SPEC)
    await renderLoadedPage()

    expect(screen.getByText(/^\/webhooks\/slack\//)).toBeInTheDocument()
    expect(screen.getByText(/no public webhook address/)).toBeInTheDocument()
    expect(screen.queryByText('Slack App Manifest')).not.toBeInTheDocument()
    expect(screen.queryByText(/display_information:/)).not.toBeInTheDocument()
  })

  it('renders no manifest and no warning on a channel with no Slack provider', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))

    expect(screen.getByText('Slack Request URL')).toBeInTheDocument()
    expect(screen.queryByText('Slack App Manifest')).not.toBeInTheDocument()
    expect(screen.queryByText(/display_information:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no public webhook address/)).not.toBeInTheDocument()
  })

  it('names the cause and the next step instead of a bare Unavailable', async () => {
    // With the URL guard in place this is the DEFAULT state of the Slack tab, so
    // "Unavailable" with no cause, under a hint telling the operator to use a URL
    // that is not there, is the copy most operators will actually see.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))

    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
    expect(screen.getByText('Available once this channel has a Slack App Name')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Enter the Slack App Name above and this channel gets its Request URL and app manifest.'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Use this URL for Slack Event Subscriptions and Interactivity.')
    ).not.toBeInTheDocument()
  })

  it('offers the Request URL and manifest as soon as an App Name is typed, before any save', async () => {
    // Slack's order is manifest first, credentials second: the xoxb token only
    // exists once the app the manifest creates has been installed. Deriving the
    // manifest from the PERSISTED spec made it appear only after the operator had
    // already done, by hand, the step the manifest is for.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))

    expect(screen.queryByText('Slack App Manifest')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Slack App Name/), { target: { value: 'Ops Bot' } })

    expect(screen.getByText('Slack App Manifest')).toBeInTheDocument()
    const manifest = screen.getByText(/display_information:/).textContent ?? ''
    const lines = manifest.split('\n')
    expect(lines.filter(line => /^\s+(name|display_name):/.test(line))).toEqual([
      '  name: "Ops Bot"',
      '    display_name: "Ops Bot"',
    ])
    const requestUrlLines = lines.filter(line => line.trim().startsWith('request_url:'))
    expect(requestUrlLines).toHaveLength(2)
    expect(new Set(requestUrlLines).size).toBe(1)
    expect(requestUrlLines[0]).toBe(
      `    request_url: ${screen.getByText(/^https:\/\/webhook\.example\.com\/webhooks\/slack\//).textContent}`
    )
    // Nothing was persisted to get here: no PUT, and the manifest is on screen.
    expect(vi.mocked(api.apiSend)).not.toHaveBeenCalled()
  })

  it('gives a Telegram-only channel with a stale Slack label no Request URL and no manifest', async () => {
    // clerum.io/slack-bot-label is a leftover display label, not a Slack provider.
    // Seeding the draft from it made this channel render a full, copyable Request
    // URL and manifest for a Slack app that does not exist, which is the paste-the-
    // wrong-URL failure this whole page guard is for.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel(LABELLED_TELEGRAM_CHANNEL, LABELLED_TELEGRAM_SPEC, STALE_SLACK_LABEL)
    await renderLoadedPage()
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))

    // The annotation still fills the visible field. Only the URL and the manifest are gated.
    expect(screen.getByLabelText(/Slack App Name/)).toHaveValue('Evenfire')
    expect(screen.getByText('Available once this channel has a Slack App Name')).toBeInTheDocument()
    expect(screen.queryByText(LABELLED_TELEGRAM_REQUEST_URL)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    expect(screen.queryByText('Slack App Manifest')).not.toBeInTheDocument()
    expect(screen.queryByText(/display_information:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no public webhook address/)).not.toBeInTheDocument()
  })

  it('offers the Request URL and manifest once an App Name is typed over a stale Slack label', async () => {
    // The draft gate exists so the manifest is reachable before anything is saved:
    // Slack hands out the xoxb token only after the app the manifest creates has
    // been installed. Excluding the annotation must not cost that.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel(LABELLED_TELEGRAM_CHANNEL, LABELLED_TELEGRAM_SPEC, STALE_SLACK_LABEL)
    await renderLoadedPage()
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }))

    expect(screen.queryByText('Slack App Manifest')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Slack App Name/), { target: { value: 'Ops Bot' } })

    expect(screen.getByText(LABELLED_TELEGRAM_REQUEST_URL)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled()
    expect(screen.getByText('Slack App Manifest')).toBeInTheDocument()
    const lines = (screen.getByText(/display_information:/).textContent ?? '').split('\n')
    expect(lines.filter(line => /^\s+(name|display_name):/.test(line))).toEqual([
      '  name: "Ops Bot"',
      '    display_name: "Ops Bot"',
    ])
    expect(lines.filter(line => line.trim().startsWith('request_url:'))).toEqual([
      `    request_url: ${LABELLED_TELEGRAM_REQUEST_URL}`,
      `    request_url: ${LABELLED_TELEGRAM_REQUEST_URL}`,
    ])
    // Nothing was persisted to get here: no PUT, and the manifest is on screen.
    expect(vi.mocked(api.apiSend)).not.toHaveBeenCalled()
  })
})
