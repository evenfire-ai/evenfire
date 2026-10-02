import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import HostDetailsPage from '../../app/hosts/[name]/page'
import * as api from '../../lib/api'
import { __resetReadRequestCacheForTests } from '../../lib/readRequestCache'
import { buildContextResource } from '../../test/fixtures/contextResource'
import { ToastProvider } from '../Toast'

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  tab: undefined as string | undefined,
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: 'quota-agent', tab: navigation.tab }),
  usePathname: () => '/agents/quota-agent',
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      href={href}
      onClick={event => {
        event.preventDefault()
        navigation.tab = String(href).split('/').at(-1)
        navigation.replace(href)
      }}
    >
      {children}
    </a>
  ),
}))
vi.mock('../AuthContext', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('../Sidebar', () => ({ Sidebar: () => <aside aria-label="Sidebar" /> }))
// These sections have their own identity/access suites. This regression owns
// the detail shell, its real overview/model editor, and physical metadata GETs.
vi.mock('../HostIdentityTab', () => ({
  HostIdentityTab: ({ hostName }: { hostName: string }) => (
    <section aria-label="Identity editor">{hostName}</section>
  ),
}))
vi.mock('../HostAccessTab', () => ({
  HostAccessTab: ({ hostName }: { hostName: string }) => (
    <section aria-label="Access editor">{hostName}</section>
  ),
}))
vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getHostDetailBundle: vi.fn(),
    getHost: vi.fn(),
    getLlmModels: vi.fn(),
    apiSend: vi.fn(),
  }
})

const host = {
  metadata: {
    name: 'quota-agent',
    resourceVersion: 'host-rv-1',
    creationTimestamp: '2026-01-01T12:00:00Z',
  },
  spec: {
    host: 'Operations agent',
    description: 'Loaded agent state survives optional metadata throttling.',
    contextRef: 'quota-context',
    model: { provider: 'openai', name: 'gpt-4o' },
    secretRef: 'operator-credential',
  },
  status: { lifecycle: { state: 'Active' } },
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function throttle(): Response {
  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      code: 'rate_limited',
      message: 'This request limit has been reached. Try again in 12 seconds.',
      retryAfterSeconds: 12,
    }),
    {
      status: 429,
      statusText: '',
      headers: { 'content-type': 'application/json', 'retry-after': '12' },
    }
  )
}

let rerenderPage: () => void
function renderPage() {
  const element = (
    <ToastProvider>
      <HostDetailsPage />
    </ToastProvider>
  )
  const result = render(element)
  // Reflect the route segment selected through the visible Next Link in this
  // component test; the real router journey is owned by the E2E lane.
  rerenderPage = () =>
    result.rerender(
      <ToastProvider>
        <HostDetailsPage />
      </ToastProvider>
    )
  return result
}

function navigate(label: string) {
  fireEvent.click(screen.getByRole('tab', { name: label }))
  rerenderPage()
}

function assertLoadedOverview() {
  expect(screen.getByRole('heading', { name: 'Agent: Operations agent' })).toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: 'Agent identity' })).getByText('Active')
  ).toBeInTheDocument()
  expect(screen.getByText(host.spec.description)).toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: 'Connectors' })).getByText('documents-connector')
  ).toBeInTheDocument()
  const access = screen.getByRole('region', { name: 'Access summary' })
  expect(within(access).getByText('Test operator')).toBeInTheDocument()
  expect(within(access).getByText('Operations team')).toBeInTheDocument()
}

describe('HostDetailsPage optional subscription throttling', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    navigation.tab = undefined
    __resetReadRequestCacheForTests()
    api.setControlUIReadPrincipal('unit-test-admin', 'admin')
    vi.clearAllMocks()
    vi.mocked(api.getHostDetailBundle).mockResolvedValue({
      host,
      contexts: [
        buildContextResource({
          metadata: { name: 'quota-context', resourceVersion: 'context-rv-1' },
          spec: { contextId: 'quota-context', mcpServers: ['documents-connector'] },
        }),
      ],
      secrets: [{ name: 'operator-credential', keys: ['openai-api-key'] }],
      users: [],
      teams: [],
      agentUsers: [
        { id: 'operator', email: 'operator@example.test', displayName: 'Test operator' },
      ],
      agentTeams: [{ id: 'operations', name: 'Operations team' }],
    } as never)
    vi.mocked(api.getHost).mockResolvedValue(host)
    vi.mocked(api.getLlmModels).mockResolvedValue({
      rows: ['gpt-4o', 'gpt-4.1'].map((model, index) => ({
        id: `model-${index}`,
        provider: 'openai',
        model,
        enabled: true,
        stale: false,
        vendor: 'OpenAI',
        display_name: null,
        context_window_tokens: null,
        created_at: '',
        updated_at: '',
      })),
    })
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/capabilities'))
        return Promise.resolve(
          json({
            providers: {
              'codex-subscription': { enabled: true },
              'grok-subscription': { enabled: true },
            },
          })
        )
      return Promise.resolve(json({ connections: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    __resetReadRequestCacheForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('makes no subscription GET for ordinary sections and reuses editor metadata across reopening', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Agent: Operations agent' })
    assertLoadedOverview()
    navigate('Identity')
    expect(screen.getByRole('region', { name: 'Identity editor' })).toHaveTextContent('quota-agent')
    navigate('Access')
    expect(screen.getByRole('region', { name: 'Access editor' })).toHaveTextContent('quota-agent')
    navigate('Connectors')
    expect(screen.getByText('documents-connector')).toBeInTheDocument()
    navigate('Models & creds')
    expect(screen.getByRole('region', { name: 'LLM configuration summary' })).toHaveTextContent(
      'gpt-4o'
    )
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByText('Loading subscription options…')).toBeNull())
    expect(new Set(fetchMock.mock.calls.map(call => String(call[0]))).size).toBe(3)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(screen.queryByText('Loading subscription options…')).toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the agent, its summaries and an unsaved model draft when the real API throttle shape rejects catalogs', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/capabilities'))
        return Promise.resolve(
          json({
            providers: {
              'codex-subscription': { enabled: true },
              'grok-subscription': { enabled: true },
            },
          })
        )
      return Promise.resolve(throttle())
    })
    renderPage()
    await screen.findByRole('heading', { name: 'Agent: Operations agent' })
    assertLoadedOverview()
    navigate('Models & creds')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit model configuration' })
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('Try again in 12 seconds.')
    expect(alert).not.toHaveTextContent(/^429$/)
    expect(screen.getByRole('heading', { name: 'Agent: Operations agent' })).toBeInTheDocument()

    const model = within(dialog).getByLabelText(/model/i, { selector: '#llm-primary-model' })
    fireEvent.click(model)
    fireEvent.click(screen.getByRole('option', { name: 'gpt-4.1' }))
    expect(model).toHaveTextContent('gpt-4.1')
    const requestsBeforeRetry = fetchMock.mock.calls.length
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeRetry)
    expect(model).toHaveTextContent('gpt-4.1')
    expect(api.apiSend).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    navigate('Overview')
    assertLoadedOverview()
    navigate('Connectors')
    expect(screen.getByText('documents-connector')).toBeInTheDocument()
    navigate('Access')
    expect(screen.getByRole('region', { name: 'Access editor' })).toHaveTextContent('quota-agent')
    navigate('Identity')
    expect(screen.getByRole('region', { name: 'Identity editor' })).toHaveTextContent('quota-agent')
    expect(api.apiSend).not.toHaveBeenCalled()
  })
})
