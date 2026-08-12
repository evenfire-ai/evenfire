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

function mockChannel(name: string, spec: ChannelSpec) {
  navigation.params = { name }
  vi.mocked(api.apiGet).mockImplementation(async path => {
    if (path === '/api/v1/admin/hosts') {
      return { items: [{ metadata: { name: 'agent-a' } }] }
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
})
