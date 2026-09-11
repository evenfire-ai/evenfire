import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
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

// A local openai-compatible primary whose only credential slot (the
// openai-compatible API key) is OPTIONAL. The Host links an LLM Secret that
// holds a DIFFERENT provider's key — the case that matters for R4-H4: the
// linked-secret usable gate must not fire just because the optional local key
// is absent.
const localHostPayload = {
  metadata: { name: 'foo' },
  spec: {
    host: 'foo-display',
    contextRef: 'ctx',
    secretRef: 'shared-llm-keys',
    channels: [] as string[],
    model: {
      provider: 'openai-compatible',
      name: 'local-llama',
      baseURL: 'http://192.168.1.50:8000/v1',
    },
  },
}

function detailBundle() {
  const host = materializeHostResource(localHostPayload, {
    metadata: { resourceVersion: 'rv-local' },
  })
  return {
    host,
    contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx', mcpServers: [] } }],
    // The linked Secret carries a usable key, but NOT the (optional)
    // openai-compatible one. The editor must still treat the local primary as
    // usable and show no mismatch banner.
    secrets: [{ name: 'shared-llm-keys', keys: ['openai-api-key'] }],
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

describe('HostDetailsPage — R4-H4: optional-only local provider and a linked Secret', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo', tab: 'model' }
    vi.mocked(api.getLlmModels).mockResolvedValue({ rows: [] })
  })

  it('does not warn that the linked secret lacks a usable credential', async () => {
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailBundle()
    )
    render(<HostDetailsPage />)

    // The model tab renders.
    expect(await screen.findByText('Current model')).toBeInTheDocument()
    // Before the fix `isProviderUsable('openai-compatible', …)` was always
    // false, so the linked-secret mismatch banner showed even with a valid key.
    expect(screen.queryByText(/does not contain a usable/i)).not.toBeInTheDocument()
  })
})
