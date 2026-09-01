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
    // Scoped to the readonly value field: the placeholder command block below
    // also renders this same path as part of its (marker-origin) endpoint.
    const requestUrlValue = document.querySelector('.cu-readonly-field.cu-copy-field__value')
    expect(requestUrlValue?.textContent ?? '').toMatch(/\/webhooks\/teams\//)
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

    // Before typing, the URL should show Unavailable
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText(/\/webhooks\/teams\/teams%3A/)).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/name/i), 'evenfire-bot')

    // After typing into the bot name field, the URL should appear. Scoped to
    // the readonly value field: the placeholder command block below also
    // renders this same path as part of its (marker-origin) endpoint.
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
    await waitFor(() => {
      const requestUrlValue = document.querySelector('.cu-readonly-field.cu-copy-field__value')
      expect(requestUrlValue?.textContent ?? '').toMatch(/\/webhooks\/teams\/teams%3A/)
    })
  })

  it('tells the operator the URL is a path when no public origin is configured', async () => {
    // Without an origin the field renders a bare path, which Teams cannot accept
    // as a Messaging endpoint. Saying "use this URL" there contradicts the
    // warning directly beneath it, so the hint has three states, not two.
    mockChannel('teams-support', { hostRef: 'agentjose' })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(
      screen.getByText('Enter the Name above and this channel gets its Teams Request URL.')
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText(/name/i), 'evenfire-bot')

    // A URL now exists, but it is relative, so the hint must not claim it is usable.
    expect(
      screen.getByText(
        'This is a path, not a full URL. Prefix it with your public webhook origin before using it as the Messaging endpoint.'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Use this URL as the Messaging endpoint for the Teams bot app.')
    ).not.toBeInTheDocument()
  })

  it('tells the operator to use the URL directly once a public origin is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('teams-support', { hostRef: 'agentjose' })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))
    await user.type(screen.getByLabelText(/name/i), 'evenfire-bot')

    expect(
      screen.getByText('Use this URL as the Messaging endpoint for the Teams bot app.')
    ).toBeInTheDocument()
    expect(
      screen.queryByText(
        'This is a path, not a full URL. Prefix it with your public webhook origin before using it as the Messaging endpoint.'
      )
    ).not.toBeInTheDocument()
  })

  it('does not render a Teams request URL for a channel with only the stale teams-app-name annotation', async () => {
    mockChannel(
      'telegram-channel',
      { telegramSettings: { botHandle: '@ops_bot' } },
      {
        'clerum.io/teams-app-name': 'Stale Teams Name',
      }
    )
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText(/\/webhooks\/teams\/teams%3A/)).not.toBeInTheDocument()
  })

  it('shows the Teams request URL once an App Name is typed over a stale annotation', async () => {
    mockChannel(
      'telegram-channel',
      { telegramSettings: { botHandle: '@ops_bot' } },
      {
        'clerum.io/teams-app-name': 'Stale Teams Name',
      }
    )
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    expect(screen.getByText('Unavailable')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/name/i), 'New Bot Name')

    // Scoped to the readonly value field: the placeholder command block below
    // also renders this same path as part of its (marker-origin) endpoint.
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
    await waitFor(() => {
      const requestUrlValue = document.querySelector('.cu-readonly-field.cu-copy-field__value')
      expect(requestUrlValue?.textContent ?? '').toMatch(/\/webhooks\/teams\/teams%3A/)
    })
  })
})

/**
 * The `teams app create` command previously existed only on the create page, so
 * an operator returning to fix or recreate a saved Teams channel had no way back
 * to it -- including the repair path when a channel is recreated under a new
 * name, which only needs the Name field retyped to regenerate a correct command.
 */
describe('EditCommunicationChannelPage Teams setup command', () => {
  it('renders the create command with an absolute endpoint once the webhook origin is public', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('teams-channel', {
      teamsSettings: { appName: 'evenfire', appId: '', tenantId: '' },
    })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    expect(screen.getByText('Create the Teams bot')).toBeInTheDocument()
    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('--name "evenfire"')
    expect(command).toHaveTextContent('--endpoint "https://webhook.example.com/webhooks/teams/')
    expect(command).toHaveTextContent('--env .env')
    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeEnabled()
    expect(screen.queryByText(/no public webhook origin/)).not.toBeInTheDocument()

    // Repair path: retyping the Name field, as when a channel is recreated under
    // a new name, regenerates the command with the new name and the same origin.
    await user.clear(screen.getByLabelText(/name/i))
    await user.type(screen.getByLabelText(/name/i), 'evenfire-bot-2')
    const updatedCommand = screen.getByText(/teams app create/).closest('pre')
    expect(updatedCommand).toHaveTextContent('--name "evenfire-bot-2"')
  })

  it('warns and still renders a placeholder-origin command when the deployment has no public webhook origin', async () => {
    // No NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL and jsdom's hostname is
    // localhost, which is the minikube case: the Teams Request URL above renders
    // as a bare path, and registering a bot against that path would point the
    // CLI at a host that does not exist -- but leaving the operator with
    // nothing to run is worse: the documented minikube workflow is to
    // substitute a real origin for the placeholder by hand, so the command
    // still renders, built from the marker origin.
    mockChannel('teams-channel', {
      teamsSettings: { appName: 'evenfire', appId: '', tenantId: '' },
    })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    const warning = document.querySelector('.cu-banner--warning')
    expect(warning?.textContent ?? '').toMatch(/no public webhook origin/)
    expect(screen.getByText('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL')).toBeInTheDocument()

    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('--name "evenfire"')
    // Pin the literal placeholder origin: this is what the operator is being
    // told to replace by hand.
    expect(command).toHaveTextContent('--endpoint "https://<public-webhook-origin>/webhooks/teams/')
    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeEnabled()
  })

  it('disables Copy on a command with a blank bot name, matching the create page', async () => {
    // hasTeamsConfigForRequestUrl is satisfied by CLIENT_ID or TENANT_ID alone,
    // so a channel with credentials but a blank Name still renders a command --
    // one that buildTeamsAppCreateCommand fills with the literal placeholder
    // <bot-name>. That placeholder must not look copyable and runnable.
    vi.stubEnv('NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL', 'https://webhook.example.com')
    mockChannel('teams-channel', {
      teamsSettings: { appName: '', appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82', tenantId: '' },
    })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    const command = screen.getByText(/teams app create/).closest('pre')
    expect(command).toHaveTextContent('--name "<bot-name>"')
    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeDisabled()

    await user.type(screen.getByLabelText(/name/i), 'evenfire-bot')

    expect(screen.getByRole('button', { name: 'Copy Teams bot create command' })).toBeEnabled()
  })

  it('renders neither the command nor the warning until this channel has Teams config', async () => {
    // Mirrors the Slack manifest gate: a URL or a command on a channel with no
    // real Teams provider is a copyable dead end, so both wait for the draft to
    // carry actual Teams config.
    mockChannel('telegram-channel', { telegramSettings: { botHandle: '@ops_bot' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Create the Teams bot')).not.toBeInTheDocument()
    expect(screen.queryByText(/teams app create/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no public webhook origin/)).not.toBeInTheDocument()
  })
})

/**
 * An operator without an authenticated Teams CLI, or without a tenant that
 * permits sideloading, used to hit both assumptions unannounced, only after
 * copying the `teams app create` command. The prerequisites block exists to
 * surface both before that command, and to point at the full guide. Unlike
 * the create page, this section renders unconditionally on the Teams tab
 * (it does not wait for teamsRequestUrl), so no draft setup is needed here.
 */
describe('EditCommunicationChannelPage Teams prerequisites', () => {
  const TEAMS_GUIDE_URL =
    'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/connect-teams.md'

  it('shows CLI install/login and the sideloading check on the Teams tab', async () => {
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    expect(screen.getByText(/npm install -g @microsoft\/teams\.cli/)).toBeInTheDocument()
    expect(screen.getByText('teams login')).toBeInTheDocument()
    expect(screen.getByText('Sideloading: enabled')).toBeInTheDocument()
    // The point of running `teams status` at all: it proves both prerequisites
    // in one shot, and a disabled result means propagation, not breakage.
    expect(screen.getByText(/proves both prerequisites/i)).toBeInTheDocument()
    expect(screen.getByText(/not that anything is broken/i)).toBeInTheDocument()
  })

  it('links to the Teams setup guide', async () => {
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    const link = screen.getByRole('link', { name: /Teams setup guide/i })
    expect(link).toHaveAttribute('href', TEAMS_GUIDE_URL)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('does not show the Teams prerequisites on the Slack tab', async () => {
    mockChannel('slack-channel', SLACK_CHANNEL_SPEC)
    await renderLoadedPage()

    expect(screen.queryByText('Sideloading: enabled')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Teams setup guide/i })).not.toBeInTheDocument()
  })
})

/**
 * spec.teamsSettings.appName is a free-form DISPLAY name: the CRD declares it
 * with no pattern (unlike tenantId right below it), control-api checks only
 * non-empty and 80 characters (unlike appId, which carries a UUID regex), and
 * the Teams CLI documents --name the same way. A kebab rule invented in the UI
 * mangled legitimate names as they were typed and, worse, locked an operator out
 * of saving ANY change on a channel whose stored name predated it.
 */
describe('EditCommunicationChannelPage Teams name validation', () => {
  it('keeps a free-form display name exactly as typed', async () => {
    mockChannel('teams-channel', { teamsSettings: { appName: '' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement
    // The placeholder is a display name, so it does not imply a kebab rule.
    expect(nameInput.placeholder).toBe('Evenfire Bot')

    await user.type(nameInput, 'My Bot')

    expect(nameInput).toHaveValue('My Bot')
  })

  it('saves an unrelated field on a channel whose stored name has a space', async () => {
    // The regression the invented rule caused: `My Bot` is a legitimate stored
    // appName, and the gate validated the whole hydrated draft, so this channel
    // could not save CLIENT_ID, access, or anything else until the name was
    // rewritten.
    mockChannel('teams-channel', { teamsSettings: { appName: 'My Bot' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    await user.type(screen.getByLabelText(/^CLIENT_ID/), '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.apiSend).toHaveBeenCalled())
    const [, , body] = vi.mocked(api.apiSend).mock.calls[0] as [string, string, { spec: unknown }]
    const teamsSettings = (body.spec as { teamsSettings: { appName: string; appId: string } })
      .teamsSettings
    expect(teamsSettings.appName).toBe('My Bot')
    expect(teamsSettings.appId).toBe('7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82')
  })

  it('blocks Save and does not persist a Teams bot name past the server limit', async () => {
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement
    await user.clear(nameInput)
    // Pasted rather than typed: 81 keystrokes through userEvent is slow, and the
    // field holds what it is given either way.
    fireEvent.change(nameInput, { target: { value: 'a'.repeat(81) } })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(
      await screen.findByText('Teams bot name must be 80 characters or fewer.')
    ).toBeInTheDocument()
    expect(api.apiSend).not.toHaveBeenCalled()
    expect(navigation.push).not.toHaveBeenCalled()
  })

  it('saves a display name typed over the previous value', async () => {
    mockChannel('teams-channel', { teamsSettings: { appName: 'evenfire' } })
    await renderLoadedPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))

    const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement
    await user.clear(nameInput)
    await user.type(nameInput, 'Evenfire Bot 2')

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.apiSend).toHaveBeenCalled())
    const [, , body] = vi.mocked(api.apiSend).mock.calls[0] as [string, string, { spec: unknown }]
    expect((body.spec as { teamsSettings: { appName: string } }).teamsSettings.appName).toBe(
      'Evenfire Bot 2'
    )
  })
})

/**
 * deleteConversation persists a full spec through persistDraft without going
 * anywhere near handleSave, so a check that lived only in handleSave let it
 * write a value Save would refuse. Validation lives on persistDraft, the one
 * boundary both paths cross.
 */
describe('EditCommunicationChannelPage conversation delete validation', () => {
  const TEAMS_CONVERSATION = {
    channelId: '19:channel@thread.tacv2',
    tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
    conversationType: 'channel',
    title: 'General',
    confirmedAt: '2026-07-10T12:00:00Z',
  }

  async function openTeamsTabWithConversation(appName: string) {
    mockChannel('teams-channel', {
      teamsSettings: { appName, appId: '', tenantId: '' },
      teams: [TEAMS_CONVERSATION],
    })
    await renderLoadedPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: /microsoft teams/i }))
    return user
  }

  it('deletes a conversation through the same validation as Save', async () => {
    const user = await openTeamsTabWithConversation('My Bot')

    await user.click(screen.getByRole('button', { name: 'Delete General' }))
    await user.click(await screen.findByRole('button', { name: 'Delete conversation' }))

    await waitFor(() => expect(api.apiSend).toHaveBeenCalled())
    const [, , body] = vi.mocked(api.apiSend).mock.calls[0] as [string, string, { spec: unknown }]
    const spec = body.spec as { teams: unknown[]; teamsSettings: { appName: string } }
    expect(spec.teams).toEqual([])
    expect(spec.teamsSettings.appName).toBe('My Bot')
  })

  it('refuses to delete a conversation while the Name field holds a value Save would refuse', async () => {
    const user = await openTeamsTabWithConversation('evenfire')

    const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement
    await user.clear(nameInput)
    fireEvent.change(nameInput, { target: { value: 'a'.repeat(81) } })

    await user.click(screen.getByRole('button', { name: 'Delete General' }))
    await user.click(await screen.findByRole('button', { name: 'Delete conversation' }))

    expect(
      await screen.findByText('Teams bot name must be 80 characters or fewer.')
    ).toBeInTheDocument()
    // The whole point: this path used to persist a spec Save rejects.
    expect(api.apiSend).not.toHaveBeenCalled()
  })
})

/**
 * The helper tests round-trip spec.email through the draft builder. They do
 * not cover the page → request boundary where #386 actually happened: Save
 * is a full-spec PUT, the edit page has no email controls, and control-api
 * preserves only credentialsSecretRef. If persistDraft ever built that PUT
 * without the loaded email groups, the inbox would drop out of the poll set
 * after an unrelated edit.
 */
describe('EditCommunicationChannelPage spec.email preservation on Save', () => {
  const EMAIL_GROUPS = [{ channelId: 'INBOX', emails: ['someone@example.com'] }]

  it('keeps populated spec.email in the PUT when only a modelled field is edited', async () => {
    mockChannel('inbox-channel', {
      email: EMAIL_GROUPS,
      telegram: [{ channelId: '424242', chatType: 'private' }],
      telegramSettings: { botHandle: '@bot', replyOnlyWhenMentioned: true },
    })
    await renderLoadedPage()

    fireEvent.change(screen.getByLabelText(/Telegram bot handle/), {
      target: { value: '@new_bot' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.apiSend).toHaveBeenCalled())
    const [method, path, body] = vi.mocked(api.apiSend).mock.calls[0] as [
      string,
      string,
      { spec: { email?: unknown; telegramSettings?: { botHandle?: string } } },
    ]
    expect(method).toBe('PUT')
    expect(path).toBe('/api/v1/admin/communication-channels/inbox-channel')
    expect(body.spec.email).toEqual(EMAIL_GROUPS)
    expect(body.spec.telegramSettings?.botHandle).toBe('@new_bot')
  })
})
