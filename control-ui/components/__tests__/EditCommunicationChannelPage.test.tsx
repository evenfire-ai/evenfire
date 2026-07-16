import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
})

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
