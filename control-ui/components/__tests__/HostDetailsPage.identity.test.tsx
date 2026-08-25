import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import HostDetailsPage from '../../app/hosts/[name]/page'
import * as api from '../../lib/api'
import {
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
} from '../../lib/codexSubscription'
import { ToastProvider } from '../Toast'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let mockParams: { name: string; tab?: string } = { name: 'foo' }

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

vi.mock('../../lib/codexSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/codexSubscription')>()
  return {
    ...actual,
    listCodexSubscriptionConnections: vi.fn().mockResolvedValue([]),
    listCodexConnectionModels: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  getAdminTeamAgents: vi.fn(),
  getAdminUserAgents: vi.fn(),
  getAgentTeams: vi.fn(),
  getAgentUsers: vi.fn(),
  getHost: vi.fn(),
  getHostDetailBundle: vi.fn(),
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
  // The model picker loads the operator allowlist via useLlmAllowedModels.
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  isSilentApiError: vi.fn().mockReturnValue(false),
}))

const host = {
  metadata: { name: 'foo' },
  spec: {
    approval: { tools: { shell_exec: true } },
    channels: ['telegram'],
    contextRef: 'ctx',
    host: 'foo-display',
    memory: { enabled: true },
    model: { name: 'gpt-5.4', provider: 'openai' },
    personalization: {
      enabled: true,
      agents: 'Use tools.',
      identity: 'I am Clerum.',
      soul: 'Be helpful.',
      user: 'User context.',
    },
    secretRef: 'openai-secret',
  },
}

function setupApiMocks() {
  ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    host,
    contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
    secrets: [{ name: 'openai-secret' }],
    users: [],
    teams: [],
    agentUsers: [],
    agentTeams: [],
  })
  ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(host)
  ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(() => {
  cleanup()
})

describe('HostDetailsPage identity integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
    setupApiMocks()
  })

  it('renders the Identity section tab with the current host name', async () => {
    mockParams = { name: 'foo', tab: 'identity' }
    const { container } = render(<HostDetailsPage />)
    expect(await screen.findByTestId('identity-tab')).toHaveTextContent('Identity editor for foo')
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
  })

  it('renders the agent detail tabs in order', async () => {
    render(<HostDetailsPage />)

    const tabs = await screen.findAllByRole('tab')

    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Overview',
      'Identity',
      'Models & creds',
      'Context',
      'Access',
      'Advanced',
    ])
  })

  it('puts Allowed models in place of Model name and spells out Secret reference', async () => {
    mockParams = { name: 'foo', tab: 'model' }
    const { container } = render(<HostDetailsPage />)

    expect(await screen.findByText('Allowed models')).toBeInTheDocument()
    expect(screen.getByText('Default model')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.4')).toBeInTheDocument()
    expect(screen.queryByText('Model name')).not.toBeInTheDocument()
    expect(screen.getByText('Credential')).toBeInTheDocument()
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
    expect(container.querySelector('.cu-agent-detail-heading')).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-toolbar')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(
      screen.getByLabelText('Allowed models · OpenAI', { selector: '#llm-allowed-openai' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Model', { selector: '#llm-primary-model' })).toBeNull()
    expect(screen.getByLabelText('Credential')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save' }).closest('.cu-agent-detail-toolbar')
    ).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-card .cu-agent-detail-scroll')).not.toBeNull()
  })

  it('shows a complete ChatGPT assignment without requiring Edit', async () => {
    mockParams = { name: 'foo', tab: 'model' }
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      {
        connectionKey: 'codex-aaa',
        displayName: 'Team A',
        status: 'connected',
        credentialRevision: 1,
        catalogRevision: 1,
        accountFingerprint: 'fp',
        catalogStatus: 'ready',
        catalogSyncedAt: '2026-08-20T00:00:00.000Z',
        lastRefreshAt: '2026-08-20T00:00:00.000Z',
        lastAuthAt: '2026-08-20T00:00:00.000Z',
        refreshLockHeld: false,
        defaultModel: 'gpt-5.1',
      },
    ])
    vi.mocked(listCodexConnectionModels).mockResolvedValue([
      { model: 'gpt-5.1', enabled: true, stale: false },
    ])
    const codexHost = {
      ...host,
      spec: {
        ...host.spec,
        secretRef: undefined,
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.1',
          connectionRef: 'codex-aaa',
        },
      },
    }
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      host: codexHost,
      contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
      secrets: [],
      users: [],
      teams: [],
      agentUsers: [],
      agentTeams: [],
    })
    render(<HostDetailsPage />)

    expect(await screen.findByText('Default model')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.1')).toBeInTheDocument()
    expect(screen.getByText('Team A')).toBeInTheDocument()
    expect(screen.queryByText('codex-aaa')).not.toBeInTheDocument()
    expect(screen.getByText('Team A')).toBeInTheDocument()
    expect(screen.getByText('Credential')).toBeInTheDocument()
    expect(screen.queryByText('Broker-backed — no LLM secret required')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('opens Advanced on the Hooks sub-tab', async () => {
    mockParams = { name: 'foo', tab: 'advanced' }
    render(<HostDetailsPage />)

    const hooksTab = await screen.findByRole('tab', { name: 'Hooks' })
    expect(hooksTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Per-tool approval' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
    expect(await screen.findByText('No guardrail hooks on this agent yet.')).toBeInTheDocument()
    // The approval editor stays unmounted until its sub-tab is selected.
    expect(screen.queryByLabelText('http_request')).toBeNull()
  })

  it('keeps Per-tool approval actions in the top toolbar without a duplicate title', async () => {
    mockParams = { name: 'foo', tab: 'advanced' }
    const { container } = render(<HostDetailsPage />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Per-tool approval' }))

    expect(await screen.findByLabelText('http_request')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save' }).closest('.cu-host-approval-section__actions')
    ).not.toBeNull()
    expect(container.querySelector('.cu-host-approval-section .cu-section-title')).toBeNull()
  })

  it('shows editable Type in Overview without Display ID and preserves personalization', async () => {
    const { container } = render(<HostDetailsPage />)
    expect(await screen.findByText('Name')).toBeInTheDocument()
    expect(await screen.findByText('Type')).toBeInTheDocument()
    expect(screen.queryByText('Display ID')).not.toBeInTheDocument()
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
    expect(container.querySelector('.cu-agent-detail-heading')).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-toolbar')).toBeNull()

    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    await waitFor(() => expect(overviewEditButton).toBeEnabled())
    fireEvent.click(overviewEditButton)
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'stateless' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const putCall = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      c => c[0] === 'PUT' && c[1] === '/api/v1/admin/hosts/foo'
    )
    const payload = putCall![2]
    expect(payload.spec.lifecycle).toEqual({ stateless: true })
    expect(payload.spec.personalization).toEqual(host.spec.personalization)
    expect(payload.spec.approval).toEqual(host.spec.approval)
  })

  // UT-3 — the identifier is readonly and only the display name (spec.host) is
  // editable. Saving is a SINGLE PUT that updates spec.host and leaves
  // metadata.name intact, with ZERO create (POST) / delete (DELETE) calls: the
  // behavioral proof that the create+migrate+delete rename dance is gone.
  it('makes the identifier readonly and saves the display name via one PUT (no rename dance)', async () => {
    render(<HostDetailsPage />)

    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    await waitFor(() => expect(overviewEditButton).toBeEnabled())
    fireEvent.click(overviewEditButton)

    // Identifier ("Name") is present but not editable.
    const nameField = screen.getByLabelText('Name')
    expect(nameField).toHaveAttribute('readonly')
    expect(nameField).toHaveValue('foo')

    // The display name (spec.host) is the editable field.
    const displayField = screen.getByLabelText('Display name')
    expect(displayField).toHaveValue('foo-display')
    fireEvent.change(displayField, { target: { value: 'Product Agents' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )

    const calls = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls
    const puts = calls.filter(c => c[0] === 'PUT' && c[1] === '/api/v1/admin/hosts/foo')
    expect(puts).toHaveLength(1)
    const payload = puts[0][2]
    expect(payload.spec.host).toBe('Product Agents')
    // The identifier is untouched: the PUT targets the same slug and never sets
    // a different metadata.name.
    expect(payload.metadata?.name).toBeUndefined()

    // The dance is gone: no create of a new host and no delete of the old one.
    expect(calls.some(c => c[0] === 'POST')).toBe(false)
    expect(calls.some(c => c[0] === 'DELETE')).toBe(false)
    // And the route was never re-navigated to a renamed slug.
    expect(replaceMock).not.toHaveBeenCalledWith('/agents/Product Agents')
    expect(pushMock).not.toHaveBeenCalledWith('/agents/Product Agents')
  })

  // Regression: Cancel must DISCARD the Display-name edit, not carry the stale
  // draft into the read-only view and the next save. Before the resetOverview
  // fix, a cancelled "Display name" edit silently persisted on the following
  // Save (spec.host written to the abandoned value).
  it('discards a cancelled Display name edit — read-only reverts and a later save keeps the saved value', async () => {
    render(<HostDetailsPage />)

    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    await waitFor(() => expect(overviewEditButton).toBeEnabled())
    fireEvent.click(overviewEditButton)

    // Type a Display name the operator then abandons.
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Discarded Draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Observable #1 (T4): the read-only view shows the last-SAVED value, not the
    // abandoned draft.
    expect(screen.getByText('foo-display')).toBeInTheDocument()
    expect(screen.queryByText('Discarded Draft')).not.toBeInTheDocument()

    // Re-open Edit and Save without touching Display name again.
    const [overviewEditButton2] = await screen.findAllByRole('button', { name: 'Edit' })
    fireEvent.click(overviewEditButton2)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )

    // Observable #2 (T4, PINNING): the persisted spec.host is the saved value,
    // NOT the discarded draft. This assertion goes red pre-fix.
    const putCall = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      c => c[0] === 'PUT' && c[1] === '/api/v1/admin/hosts/foo'
    )
    expect(putCall![2].spec.host).toBe('foo-display')
  })

  // Collateral regression: resetOverviewDrafts must NOT clobber a LIVE Context-tab
  // edit. contextRefDraft is written by both saveHost (Overview) and the Context
  // tab's own editingContext session; reverting it on Overview Edit-open/Cancel
  // while that session is open silently discards the operator's in-progress pick.
  it('preserves a live Context-tab selection across an Overview Edit-open/Cancel', async () => {
    // Two contexts so the Context tab can switch selection; saved = ctx-a.
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      host: { ...host, spec: { ...host.spec, contextRef: 'ctx-a' } },
      contexts: [
        { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a' } },
        { metadata: { name: 'ctx-b' }, spec: { contextId: 'ctx-b' } },
      ],
      secrets: [{ name: 'openai-secret' }],
      users: [],
      teams: [],
      agentUsers: [],
      agentTeams: [],
    })

    // Land on the Context tab, open its edit session, pick a DIFFERENT context.
    mockParams = { name: 'foo', tab: 'contexts' }
    const view = render(<HostDetailsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit context' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ctx-b' } })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ctx-b')

    // Switch to Overview and fire BOTH resetOverviewDrafts sites: Edit-open, Cancel.
    mockParams = { name: 'foo' }
    view.rerender(
      <ToastProvider>
        <HostDetailsPage />
      </ToastProvider>
    )
    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    await waitFor(() => expect(overviewEditButton).toBeEnabled())
    fireEvent.click(overviewEditButton)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Back on the Context tab (still editing): the in-progress ctx-b must survive.
    mockParams = { name: 'foo', tab: 'contexts' }
    view.rerender(
      <ToastProvider>
        <HostDetailsPage />
      </ToastProvider>
    )

    // PINNING (T4): the Context select still shows the unsaved ctx-b, not the
    // reverted saved ctx-a. Pre-collateral-fix this reads 'ctx-a'.
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ctx-b')
  })

  it('saves a Codex-only Host without secretRef and keeps metadata.name as identity', async () => {
    const { secretRef: _omit, ...specWithoutSecret } = host.spec
    void _omit
    const codexHost = {
      ...host,
      spec: {
        ...specWithoutSecret,
        model: { provider: 'codex-subscription', name: 'gpt-5.1' },
      },
    }
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      host: codexHost,
      contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
      secrets: [{ name: 'openai-secret' }],
      users: [],
      teams: [],
      agentUsers: [],
      agentTeams: [],
    })
    ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(codexHost)
    ;(api.getLlmModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [
        {
          id: 'm-codex',
          provider: 'codex-subscription',
          model: 'gpt-5.1',
          vendor: 'OpenAI',
          display_name: null,
          context_window_tokens: null,
          enabled: true,
          stale: false,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    mockParams = { name: 'foo', tab: 'model' }
    render(<HostDetailsPage />)

    expect(await screen.findByText('No credential assigned')).toBeInTheDocument()
    expect(screen.getByText('Credential')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI Codex Subscription')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Credential')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /ChatGPT subscription/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.apiSend).not.toHaveBeenCalledWith(
      'PUT',
      '/api/v1/admin/hosts/foo',
      expect.objectContaining({
        spec: expect.objectContaining({
          model: expect.objectContaining({ connectionRef: 'unassigned' }),
        }),
      })
    )
    expect(screen.queryByText('OpenAI Codex Subscription')).not.toBeInTheDocument()
  })
})
