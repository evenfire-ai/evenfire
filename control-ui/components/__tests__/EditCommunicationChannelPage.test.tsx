import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  /** The panel's own copy for a stored-key read that failed, written out rather
   *  than imported: this copy is the fix, so a reworded panel must fail here. */
  const STORED_KEYS_ERROR =
    'Could not check which credentials are stored. You can still rotate a value; deleting one needs a successful read.'

  function credentialReadCount(name: string): number {
    return vi
      .mocked(api.apiGet)
      .mock.calls.filter(
        ([path]) => path === `/api/v1/admin/communication-channels/${name}/credentials`
      ).length
  }

  /** Like mockChannel, but also answers the per-channel credentials read.
   *  Pass an Error to make that read fail, or an array to answer successive
   *  reads in order (the last entry answers every read after it). */
  function mockChannelCredentials(name: string, spec: ChannelSpec, credentials: unknown) {
    navigation.params = { name }
    const answers = Array.isArray(credentials) ? [...credentials] : [credentials]
    vi.mocked(api.apiGet).mockImplementation(async path => {
      if (path === '/api/v1/admin/hosts') {
        return { items: [{ metadata: { name: 'agent-a' } }] }
      }
      if (path === `/api/v1/admin/communication-channels/${name}/credentials`) {
        const answer = answers.length > 1 ? answers.shift() : answers[0]
        if (answer instanceof Error) throw answer
        return answer
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

  it('says the credentials read failed instead of reporting them as empty or pending', async () => {
    // A denied or failed read says nothing about what is stored, so the empty
    // state would report "no credentials" on a channel that has them. The
    // pending state is just as wrong once the request is over: the panel
    // disables every control while it believes a read is in flight, so
    // swallowing the error left the whole panel dead, silently, until a reload
    // — which repeats the failure whenever the cause is not transient.
    mockChannelCredentials(
      TELEGRAM_ONLY_CHANNEL,
      TELEGRAM_ONLY_SPEC,
      new Error('secrets is forbidden')
    )
    await renderLoadedPage()

    await waitFor(() => {
      expect(screen.getByText(STORED_KEYS_ERROR)).toBeInTheDocument()
    })
    // The cause reaches the operator rather than being discarded with the
    // rejected promise.
    expect(screen.getByText('secrets is forbidden')).toBeInTheDocument()

    const telegramToken = screen.getByLabelText('Telegram Bot Token') as HTMLInputElement
    expect(telegramToken.getAttribute('aria-busy')).toBe(null)
    expect(telegramToken.value).toBe('')
    expect(telegramToken.placeholder).toBe('Stored value unknown')
    // Rotation still works: a PUT overwrites whatever is there and needs to
    // know nothing about it. Deleting an invisible key does not.
    expect(screen.getByLabelText('Edit Telegram Bot Token')).toBeEnabled()
    expect(screen.getByLabelText('Delete Telegram Bot Token')).toBeDisabled()
    // The page itself still loaded: the read failure is scoped to the panel.
    expect(screen.getByLabelText(/Telegram bot handle/)).toHaveValue('@ops_bot')
  })

  it('retries the credentials read from the panel and recovers', async () => {
    // The failure is reachable from a control-ui newer than control-api (404 on
    // this route, a window on every rolling update) or any transient apiserver
    // failure, so the way out has to be cheaper than a page reload.
    mockChannelCredentials(TELEGRAM_ONLY_CHANNEL, TELEGRAM_ONLY_SPEC, [
      new Error('secrets is forbidden'),
      {
        name: TELEGRAM_ONLY_CHANNEL,
        secretName: 'cc-jose-tg-credentials',
        namespace: 'channels',
        keys: ['telegram-bot-token'],
      },
    ])
    await renderLoadedPage()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })
    expect(credentialReadCount(TELEGRAM_ONLY_CHANNEL)).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Telegram Bot Token')).toHaveValue('**********')
    })
    expect(credentialReadCount(TELEGRAM_ONLY_CHANNEL)).toBe(2)
    expect(screen.queryByText(STORED_KEYS_ERROR)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('treats an unusable credentials response as a failed read, not as no credentials', async () => {
    // 200 with a body that carries no key list is exactly as uninformative as a
    // rejection, and parked the panel in the same permanent pending state.
    mockChannelCredentials(TELEGRAM_ONLY_CHANNEL, TELEGRAM_ONLY_SPEC, {
      name: TELEGRAM_ONLY_CHANNEL,
      namespace: 'channels',
    })
    await renderLoadedPage()

    await waitFor(() => {
      expect(screen.getByText(STORED_KEYS_ERROR)).toBeInTheDocument()
    })
    expect(
      screen.getByText('The credentials response did not list the stored keys.')
    ).toBeInTheDocument()
    const telegramToken = screen.getByLabelText('Telegram Bot Token') as HTMLInputElement
    expect(telegramToken.placeholder).toBe('Stored value unknown')
    expect(screen.getByLabelText('Edit Telegram Bot Token')).toBeEnabled()
  })
})

/** Both strings are written out rather than imported: this copy IS the feature,
 *  so a reworded page must fail here instead of quietly passing. */
const EMPTY_CONVERSATIONS_COPY =
  'No conversations confirmed yet. Each user links their own by copying the verify command from their profile page and sending it in the conversation they want to link.'
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

describe('EditCommunicationChannelPage Teams request URL', () => {
  it('shows the Teams request URL from an unsaved draft, before any Teams settings are persisted', async () => {
    mockChannel('teams-support', { hostRef: 'agentjose' })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))
    await user.type(screen.getByLabelText(/name/i), 'evenfire-bot')

    expect(await screen.findByText(/\/webhooks\/teams\/teams%3A/)).toBeInTheDocument()
  })
})
