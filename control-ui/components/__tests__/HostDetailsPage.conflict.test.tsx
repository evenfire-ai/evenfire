import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import HostDetailsPage from '../../app/hosts/[name]/page'
import * as api from '../../lib/api'
import { materializeHostResource } from '../../test/fixtures/contextResource'
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

const baseSpec = {
  approval: { tools: { shell_exec: true } },
  channels: [],
  contextRef: 'ctx',
  host: 'foo-display',
  model: { name: 'gpt-5.4-mini', provider: 'openai' },
  secretRef: 'openai-secret',
}

type TestHost = {
  metadata: { name: string; resourceVersion?: string }
  spec: Record<string, unknown>
  status?: Record<string, unknown>
}

// The version the edit form is BUILT FROM (the loadData read).
const formLoadHost: TestHost = {
  metadata: { name: 'foo', resourceVersion: 'rv-form-load' },
  spec: { ...baseSpec },
}

// A NEWER version returned by saveHost's pre-save re-fetch — proves the PUT
// carries the form-load version, not the re-fetch one (AP-6: the guard must
// cover the whole human edit window).
const refetchedHost: TestHost = {
  metadata: { name: 'foo', resourceVersion: 'rv-refetch' },
  spec: { ...baseSpec },
}

const modelCatalogRows = [
  {
    id: 'openai-gpt-5-4-mini',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    vendor: 'OpenAI',
    display_name: null,
    context_window_tokens: 400000,
    enabled: true,
    source: 'manual' as const,
    stale: false,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'openai-gpt-5-4',
    provider: 'openai',
    model: 'gpt-5.4',
    vendor: 'OpenAI',
    display_name: null,
    context_window_tokens: 400000,
    enabled: true,
    source: 'manual' as const,
    stale: false,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'openai-gpt-4-1',
    provider: 'openai',
    model: 'gpt-4.1',
    vendor: 'OpenAI',
    display_name: null,
    context_window_tokens: 1047576,
    enabled: true,
    source: 'manual' as const,
    stale: false,
    created_at: '',
    updated_at: '',
  },
]

const defaultSecretResources = [
  { name: 'openai-secret', keys: ['openai-api-key'] },
  { name: 'anthropic-secret', keys: ['claude-api-key'] },
]

function detailBundle(bundleHost: TestHost, secrets = defaultSecretResources) {
  return {
    host: bundleHost,
    contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx', mcpServers: [] } }],
    secrets,
    users: [],
    teams: [],
    agentUsers: [],
    agentTeams: [],
  }
}

function setupApiMocks(
  bundleHost: TestHost,
  refetchHost: TestHost = bundleHost,
  secrets = defaultSecretResources
) {
  ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...detailBundle(bundleHost, secrets),
  })
  ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(refetchHost)
  ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function navigateToTab(view: ReturnType<typeof rtlRender>, tab: 'overview' | 'model'): void {
  mockParams = tab === 'overview' ? { name: 'foo' } : { name: 'foo', tab }
  view.rerender(
    <ToastProvider>
      <HostDetailsPage />
    </ToastProvider>
  )
}

async function openOverviewEdit() {
  const overviewEditButton = await screen.findByRole('button', { name: 'Edit agent name' })
  await waitFor(() => expect(overviewEditButton).toBeEnabled())
  fireEvent.click(overviewEditButton)
}

function findHostPutPayload(): Record<string, unknown> {
  const call = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
    args => args[0] === 'PUT' && args[1] === '/api/v1/admin/hosts/foo'
  )
  expect(call).toBeDefined()
  return call![2] as Record<string, unknown>
}

function configureModelCatalog() {
  vi.mocked(api.getLlmModels).mockResolvedValue({ rows: modelCatalogRows })
}

// Shape produced by lib/api formatApiError for the facade's AP-6 response
// body {error:'conflict', reason:'resource_changed'}.
function makeConflictError(): Error {
  return Object.assign(new Error('409 Conflict - conflict'), {
    status: 409,
    code: 'conflict',
  })
}

afterEach(() => {
  cleanup()
})

describe('HostDetailsPage AP-6 save conflict handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
  })

  it('sends the resourceVersion captured at form load, not the pre-save re-fetch version', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const payload = findHostPutPayload() as { metadata?: { resourceVersion?: string } }
    expect(payload.metadata?.resourceVersion).toBe('rv-form-load')
  })

  it('omits metadata when the form-load read carried no resourceVersion (legacy last-write-wins)', async () => {
    setupApiMocks({ metadata: { name: 'foo' }, spec: { ...baseSpec } })
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    expect('metadata' in findHostPutPayload()).toBe(false)
  })

  it('renders the both-causes conflict banner on 409, keeps the edit form open, and shows no success toast', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(makeConflictError())
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))

    // The resourceVersion precondition is whole-object, so a 409 cannot tell a
    // human edit apart from the agent's own lifecycle tick. The banner must
    // cover BOTH causes truthfully rather than asserting "someone else edited".
    expect(
      await screen.findByText(
        "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
      )
    ).toBeInTheDocument()
    // It must NOT overclaim the human-edit cause.
    expect(screen.queryByText(/modified by someone else/i)).not.toBeInTheDocument()
    // No silent success…
    expect(screen.queryByText('Agent configuration saved.')).not.toBeInTheDocument()
    // …and the edit form stays open so the operator's draft is preserved.
    expect(screen.getByRole('button', { name: 'Save agent name' })).toBeInTheDocument()
  })

  it('recovers after a 409: reloading then re-applying the same save succeeds and clears the banner', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    const apiSendMock = api.apiSend as unknown as ReturnType<typeof vi.fn>
    // First save conflicts (lifecycle tick or concurrent edit); the retry — the
    // operator's re-applied change after a reload — succeeds.
    apiSendMock.mockRejectedValueOnce(makeConflictError()).mockResolvedValue({})
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))
    expect(
      await screen.findByText(
        "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
      )
    ).toBeInTheDocument()
    // Draft survives: the form is still in edit mode after the conflict.
    expect(screen.getByRole('button', { name: 'Save agent name' })).toBeInTheDocument()

    // Re-apply the change (the reload+re-apply recovery the banner instructs).
    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))

    // The retry succeeds: success toast shows and the conflict banner is gone.
    expect(await screen.findByText('Agent configuration saved.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(/lifecycle state updated/i)).not.toBeInTheDocument()
    )
    expect(apiSendMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the non-conflict error path intact (generic message, form stays open)', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save agent name' })).toBeInTheDocument()
  })
})

describe('HostDetailsPage current model and credential flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
    vi.mocked(api.getLlmModels).mockResolvedValue({ rows: [] })
    setupApiMocks(formLoadHost, refetchedHost)
  })

  it('opens the linked LLM Secret editor without navigating or saving the Host', async () => {
    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    expect(await screen.findByText('Current model')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit LLM Secret credentials' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Update LLM secret openai-secret')).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
    expect(
      (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        args => args[0] === 'PUT' && args[1] === '/api/v1/admin/hosts/foo'
      )
    ).toBe(false)
  })

  it('opens the model configuration editor separately from credential editing', async () => {
    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    expect(await screen.findByText('Current model')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.getByRole('region', { name: 'LLM configuration' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save model configuration' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update secret' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save model configuration' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const payload = findHostPutPayload() as { spec: Record<string, unknown> }
    expect(payload.spec.model).toEqual(baseSpec.model)
    expect(payload.spec.secretRef).toBe('openai-secret')
    expect(await screen.findByText('Model configuration saved.')).toBeInTheDocument()
  })

  it('cancels model changes, reloads the Host, and restores authoritative server state', async () => {
    configureModelCatalog()
    const authoritativeHost: TestHost = {
      metadata: { name: 'foo', resourceVersion: 'rv-authoritative-cancel' },
      spec: {
        ...baseSpec,
        model: { name: 'gpt-4.1', provider: 'openai' },
      },
    }
    vi.mocked(api.getHostDetailBundle)
      .mockResolvedValueOnce(detailBundle(formLoadHost))
      .mockResolvedValue(detailBundle(authoritativeHost))

    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    await screen.findByText('Current model')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByLabelText('Current model', { selector: '#llm-primary-model' }))
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-5.4' }))
    expect(
      screen.getByLabelText('Current model', { selector: '#llm-primary-model' })
    ).toHaveTextContent('gpt-5.4')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel model changes' }))

    expect(await screen.findByText('gpt-4.1')).toBeInTheDocument()
    await waitFor(() => expect(api.getHostDetailBundle).toHaveBeenCalledTimes(2))
    expect(
      screen.queryByRole('button', { name: 'Save model configuration' })
    ).not.toBeInTheDocument()
    expect(
      (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        args => args[0] === 'PUT' && args[1] === '/api/v1/admin/hosts/foo'
      )
    ).toBe(false)
  })

  it('keeps the model draft and displays the error when the Host save fails', async () => {
    configureModelCatalog()
    const formSpec = {
      ...baseSpec,
      description: 'Preserve this unrelated field',
      channels: ['slack'],
      approval: { tools: { shell_exec: true, web_search: false } },
      workflowControl: { scopes: ['chat'] },
      customField: { keep: true },
    }
    const formHost: TestHost = {
      metadata: { name: 'foo', resourceVersion: 'rv-model-form' },
      spec: formSpec,
    }
    setupApiMocks(formHost, formHost)
    ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('model save failed')
    )

    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    await screen.findByText('Current model')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByLabelText('Current model', { selector: '#llm-primary-model' }))
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-5.4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save model configuration' }))

    expect(await screen.findByText('model save failed')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Current model', { selector: '#llm-primary-model' })
    ).toHaveTextContent('gpt-5.4')
    expect(screen.getByRole('button', { name: 'Save model configuration' })).toBeInTheDocument()
    expect(screen.queryByText('Model configuration saved.')).not.toBeInTheDocument()

    const payload = findHostPutPayload() as {
      metadata?: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
    expect(payload.metadata?.resourceVersion).toBe('rv-model-form')
    expect(payload.spec).toMatchObject({
      description: 'Preserve this unrelated field',
      channels: ['slack'],
      approval: { tools: { shell_exec: true, web_search: false } },
      workflowControl: { scopes: ['chat'] },
      customField: { keep: true },
      model: { provider: 'openai', name: 'gpt-5.4' },
      secretRef: 'openai-secret',
    })
  })

  it('renders the authoritative Host state after a successful model save', async () => {
    configureModelCatalog()
    const formSpec = {
      ...baseSpec,
      description: 'Keep this description',
      channels: ['telegram'],
      approval: { tools: { shell_exec: true } },
      lifecycle: { stateless: false },
      customField: 'keep-me',
    }
    const formHost: TestHost = {
      metadata: { name: 'foo', resourceVersion: 'rv-model-form' },
      spec: formSpec,
    }
    const preSaveHost: TestHost = {
      metadata: { name: 'foo', resourceVersion: 'rv-model-refetch' },
      spec: formSpec,
    }
    const authoritativeHost: TestHost = {
      metadata: { name: 'foo', resourceVersion: 'rv-model-after-save' },
      spec: {
        ...formSpec,
        // The refresh is authoritative even if the server normalizes the
        // selected model or another writer changes it during the save.
        model: { provider: 'openai', name: 'gpt-4.1' },
      },
    }
    setupApiMocks(formHost, preSaveHost)
    vi.mocked(api.getHostDetailBundle)
      .mockResolvedValueOnce(detailBundle(formHost))
      .mockResolvedValue(detailBundle(authoritativeHost))

    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    await screen.findByText('Current model')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByLabelText('Current model', { selector: '#llm-primary-model' }))
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-5.4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save model configuration' }))

    expect(await screen.findByText('Model configuration saved.')).toBeInTheDocument()
    expect(await screen.findByText('gpt-4.1')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save model configuration' })
    ).not.toBeInTheDocument()

    const payload = findHostPutPayload() as {
      metadata?: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
    expect(payload.metadata?.resourceVersion).toBe('rv-model-form')
    expect(payload.spec).toMatchObject({
      description: 'Keep this description',
      channels: ['telegram'],
      approval: { tools: { shell_exec: true } },
      lifecycle: { stateless: false },
      customField: 'keep-me',
      model: { provider: 'openai', name: 'gpt-5.4' },
      secretRef: 'openai-secret',
    })
    expect(api.getHost).toHaveBeenCalledWith('foo')
    expect(api.getHostDetailBundle).toHaveBeenCalledTimes(2)
  })

  it('blocks removing a stored fallback credential slot still referenced by the Host policy', async () => {
    // Producer-valid Host data: the custom Secret key is referenced by an
    // active fallback, not merely shown as an arbitrary extra Secret key.
    const fallbackSlot = 'claude-api-key-fb1'
    const hostWithFallback = materializeHostResource(
      {
        metadata: { name: 'foo' },
        spec: {
          ...baseSpec,
          llmPolicy: {
            fallbacks: [
              {
                provider: 'claude',
                model: 'claude-sonnet-4-6',
                credentialSlot: fallbackSlot,
              },
            ],
          },
        },
      },
      { metadata: { resourceVersion: 'rv-fallback-policy' } }
    )
    setupApiMocks(hostWithFallback, hostWithFallback, [
      { name: 'openai-secret', keys: ['openai-api-key', fallbackSlot] },
      { name: 'anthropic-secret', keys: ['claude-api-key'] },
    ])

    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    await screen.findByText('Current model')
    fireEvent.click(screen.getByRole('button', { name: 'Edit LLM Secret credentials' }))

    const anthropicGroup = screen
      .getByText('Anthropic', { selector: '.cu-llm-cred-group__title' })
      .closest('section')
    expect(anthropicGroup).not.toBeNull()
    fireEvent.click(
      within(anthropicGroup as HTMLElement).getByRole('button', {
        name: 'Remove extra credential slot',
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Update secret' }))

    expect(
      await screen.findByText(
        new RegExp(`Cannot remove "${fallbackSlot}".*active fallback.*credential slot`)
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(
      (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        args => args[0] === 'PUT' && args[1] === '/api/v1/admin/secrets'
      )
    ).toBe(false)
  })

  it('changes the linked LLM Secret from the inline credentials dropdown', async () => {
    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    await screen.findByText('Current model')

    fireEvent.click(screen.getByRole('button', { name: 'LLM Secret' }))
    fireEvent.click(screen.getByRole('option', { name: /anthropic-secret/ }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const payload = findHostPutPayload() as { spec: Record<string, unknown> }
    expect(payload.spec.secretRef).toBe('anthropic-secret')
    expect(payload.spec.model).toEqual(baseSpec.model)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('updates the linked Secret without writing Host model configuration', async () => {
    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    await screen.findByText('Current model')
    fireEvent.click(screen.getByRole('button', { name: 'Edit LLM Secret credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace OpenAI API key' }))
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), {
      target: { value: 'sk-live' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update secret' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: 'openai-secret',
        merge: true,
        stringData: { 'openai-api-key': 'sk-live' },
      })
    )
    expect(
      (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        args => args[0] === 'PUT' && args[1] === '/api/v1/admin/hosts/foo'
      )
    ).toBe(false)
  })
})

describe('HostDetailsPage cross-tab draft preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
    vi.mocked(api.getLlmModels).mockResolvedValue({ rows: [] })
    setupApiMocks(formLoadHost, refetchedHost)
  })

  it('preserves an open Overview draft when model configuration is saved', async () => {
    const view = render(<HostDetailsPage />)
    await openOverviewEdit()
    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'unsaved-overview-name' },
    })

    navigateToTab(view, 'model')
    expect(await screen.findByText('Current model')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // Keep the existing static-credentials secret. Emptying it now fails
    // closed (Codex broker chains omit secretRef; OpenAI still requires one).
    fireEvent.click(screen.getByRole('button', { name: 'Save model configuration' }))
    expect(await screen.findByText('Model configuration saved.')).toBeInTheDocument()

    navigateToTab(view, 'overview')
    expect(await screen.findByDisplayValue('unsaved-overview-name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save agent name' })).toBeInTheDocument()
  })

  it('fails closed instead of writing an unassigned Codex connectionRef', async () => {
    const { secretRef: _omit, ...specWithoutSecret } = baseSpec
    void _omit
    const codexHost: TestHost = {
      metadata: { name: 'foo', resourceVersion: 'rv-form-load' },
      spec: {
        ...specWithoutSecret,
        model: { provider: 'codex-subscription', name: 'gpt-5.1' },
      },
    }
    setupApiMocks(codexHost, codexHost)

    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    expect(await screen.findByText('Current model')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.getByLabelText('Credential')).toBeInTheDocument()
    expect(screen.queryByText('Secret reference')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /ChatGPT subscription/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save model configuration' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save model configuration' }))

    expect(api.apiSend).not.toHaveBeenCalledWith(
      'PUT',
      '/api/v1/admin/hosts/foo',
      expect.objectContaining({
        spec: expect.objectContaining({
          model: expect.objectContaining({ connectionRef: 'unassigned' }),
        }),
      })
    )
  })
})
