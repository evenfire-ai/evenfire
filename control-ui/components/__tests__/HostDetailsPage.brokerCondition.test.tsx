import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { OAI_EGRESS_BROKERS_CONDITION_TYPE } from '@clerum/egress-policy'
import HostDetailsPage from '../../app/hosts/[name]/page'
import * as api from '../../lib/api'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import { ToastProvider } from '../Toast'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let mockParams: { name: string; tab?: string } = { name: 'foo', tab: 'model' }

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
  usePathname: () => '/agents/foo',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('../Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}))

vi.mock('../HostIdentityTab', () => ({
  HostIdentityTab: ({ hostName }: { hostName: string }) => (
    <div data-testid="identity-tab">Identity editor for {hostName}</div>
  ),
}))

vi.mock('../HostAccessTab', () => ({
  HostAccessTab: ({ hostName }: { hostName: string }) => (
    <div data-testid="access-tab">Access editor for {hostName}</div>
  ),
}))

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  getAdminTeamAgents: vi.fn(),
  getAdminUserAgents: vi.fn(),
  getAgentTeams: vi.fn(),
  getAgentUsers: vi.fn(),
  getHost: vi.fn(),
  getHostDetailBundle: vi.fn(),
  getMcpServers: vi.fn(),
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  isSilentApiError: vi.fn().mockReturnValue(false),
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
  updateContext: vi.fn(),
}))

// A local `openai-compatible` primary is the case that produces an egress
// broker; the LAN endpoint is what HCC reports on.
const brokerHostPayload = {
  metadata: { name: 'foo' },
  spec: {
    host: 'foo-display',
    contextRef: 'ctx',
    secretRef: '',
    channels: [] as string[],
    model: {
      provider: 'openai-compatible',
      name: 'local-llama',
      baseURL: 'http://10.96.0.1:6443/v1',
    },
  },
}

// T1 tension (declared in the commit): this fixture is NOT derived by executing
// the producer — HCC runs in another process. It is anchored to the two things
// that actually fix the shape: the condition `type` comes from the shared
// @clerum/egress-policy constant (the same value HCC stamps), and the
// {type,status,reason,message} field shape is fixed by the Host CRD's
// status.conditions schema. Same practice the repo uses for cross-layer enums.
const FALSE_CONDITION = {
  type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
  status: 'False',
  reason: 'ClusterInternal',
  message: 'primary: cluster_internal; fallback-1: path_unsafe',
  lastTransitionTime: '2026-09-10T00:00:00Z',
}

const EXPECTED_NOTICE = `Local endpoint not provisioned — ${FALSE_CONDITION.reason}: ${FALSE_CONDITION.message}`

function hostWithConditions(conditions?: Array<Record<string, unknown>>) {
  const host = materializeHostResource(brokerHostPayload, {
    metadata: { resourceVersion: 'rv-broker' },
  })
  return {
    ...host,
    ...(conditions ? { status: { conditions } } : {}),
  }
}

function detailBundle(host: ReturnType<typeof hostWithConditions>) {
  return {
    host,
    contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx', mcpServers: [] } }],
    secrets: [] as Array<{ name: string; keys: string[] }>,
    users: [],
    teams: [],
    agentUsers: [],
    agentTeams: [],
  }
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(() => {
  cleanup()
})

describe('HostDetailsPage egress-broker condition notice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo', tab: 'model' }
    vi.mocked(api.getLlmModels).mockResolvedValue({ rows: [] })
  })

  it('surfaces the not-provisioned notice when the broker condition is False', async () => {
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailBundle(hostWithConditions([FALSE_CONDITION]))
    )
    render(<HostDetailsPage />)

    expect(await screen.findByText(EXPECTED_NOTICE)).toBeInTheDocument()
  })

  it('renders no notice when the Host carries no egress-broker condition', async () => {
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailBundle(hostWithConditions())
    )
    render(<HostDetailsPage />)

    // Wait for the model tab to render its stable heading, then assert absence.
    expect(await screen.findByText('Current model')).toBeInTheDocument()
    expect(screen.queryByText(/Local endpoint not provisioned/)).not.toBeInTheDocument()
    await waitFor(() => expect(api.getHostDetailBundle).toHaveBeenCalled())
  })

  it('renders no notice when the broker condition is True', async () => {
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailBundle(
        hostWithConditions([
          {
            type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
            status: 'True',
            reason: 'AllSlotsProvisioned',
            message: '1 broker(s)',
            lastTransitionTime: '2026-09-10T00:00:00Z',
          },
        ])
      )
    )
    render(<HostDetailsPage />)

    expect(await screen.findByText('Current model')).toBeInTheDocument()
    expect(screen.queryByText(/Local endpoint not provisioned/)).not.toBeInTheDocument()
  })
})
