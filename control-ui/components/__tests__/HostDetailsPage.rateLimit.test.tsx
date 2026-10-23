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
  name: 'quota-agent',
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: navigation.name, tab: navigation.tab }),
  usePathname: () => `/agents/${navigation.name}`,
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
    getMcpServers: vi.fn(),
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
    navigation.name = 'quota-agent'
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
    // This suite tracks only subscription metadata GETs. Connector details use
    // the API client directly and are outside that rate-limit contract.
    vi.mocked(api.getMcpServers).mockResolvedValue({ items: [] } as never)
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
    vi.useRealTimers()
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
    const dialog = screen.getByRole('dialog', { name: 'Edit model & credentials' })
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

  it('clears the error once the background recovery rereads the inventory, without a click or another read', async () => {
    vi.useFakeTimers()
    // The server's shared subscription-read quota: two reads per twelve-second window.
    const windowMs = 12_000
    const startedAt = Date.now()
    const reads: Array<{ url: string; window: number; status: number }> = []
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      const window = Math.floor((Date.now() - startedAt) / windowMs)
      const inWindow = reads.filter(read => read.window === window).length
      const response =
        inWindow >= 2
          ? throttle()
          : url.endsWith('/capabilities')
            ? json({
                providers: {
                  'codex-subscription': { enabled: true },
                  'grok-subscription': { enabled: true },
                },
              })
            : json({ connections: [] })
      reads.push({ url, window, status: response.status })
      return Promise.resolve(response)
    })
    const flush = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
    renderPage()
    await flush()
    navigate('Models & creds')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'Edit model & credentials' })
    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent('Try again in 12 seconds.')
    expect(reads.map(read => read.status)).toEqual([200, 200, 429])

    // The shared recovery reads the denied inventory once the deadline passes,
    // and the editor shows that result without a click or a read of its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(windowMs)
    })
    await flush()
    const afterDeadline = reads.filter(read => read.window >= 1)
    expect(afterDeadline).toHaveLength(1)
    expect(afterDeadline[0]?.status).toBe(200)
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Loading subscription options…')).toBeNull()
    expect(api.apiSend).not.toHaveBeenCalled()
  })

  it.each(['codex-subscription', 'grok-subscription'] as const)(
    'does not confirm retained %s models under a different connection that throttles, then recovers only that binding',
    async provider => {
      vi.useFakeTimers()
      const modelA = provider === 'codex-subscription' ? 'gpt-5.1' : 'grok-4.6'
      const modelB = provider === 'codex-subscription' ? 'gpt-5.4' : 'grok-4.7'
      vi.mocked(api.getHostDetailBundle).mockImplementation(
        async name =>
          ({
            host: {
              ...host,
              metadata: { ...host.metadata, name },
              spec: {
                ...host.spec,
                secretRef: undefined,
                model: {
                  provider,
                  name: modelA,
                  connectionRef: name === 'quota-agent' ? 'connection-a' : 'connection-b',
                },
              },
            },
            contexts: [
              buildContextResource({
                metadata: { name: 'quota-context' },
                spec: { contextId: 'quota-context', mcpServers: ['documents-connector'] },
              }),
            ],
            secrets: [],
            users: [],
            teams: [],
            agentUsers: [],
            agentTeams: [],
          }) as never
      )
      vi.mocked(api.getLlmModels).mockResolvedValue({
        rows: [modelA, modelB].map((model, index) => ({
          id: `binding-model-${index}`,
          provider,
          model,
          enabled: true,
          stale: false,
          vendor: provider === 'codex-subscription' ? 'OpenAI' : 'xAI',
          display_name: null,
          context_window_tokens: null,
          created_at: '',
          updated_at: '',
        })),
      })
      let bReads = 0
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/capabilities'))
          return Promise.resolve(
            json({
              providers: {
                'codex-subscription': { enabled: true },
                'grok-subscription': { enabled: true },
              },
            })
          )
        if (url.endsWith('/connection-a/models'))
          return Promise.resolve(json({ models: [{ model: modelA, enabled: true, stale: false }] }))
        if (url.endsWith('/connection-b/models')) {
          bReads += 1
          return Promise.resolve(
            bReads === 1
              ? throttle()
              : json({ models: [{ model: modelB, enabled: true, stale: false }] })
          )
        }
        return Promise.resolve(
          json({
            connections: ['a', 'b'].map(suffix => ({
              connectionKey: `connection-${suffix}`,
              displayName: `Connection ${suffix}`,
              status: 'connected',
              credentialRevision: 1,
              catalogRevision: 1,
              catalogStatus: 'ready',
              defaultModel: suffix === 'a' ? modelA : modelB,
            })),
          })
        )
      })
      const flush = () =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(0)
        })
      renderPage()
      await flush()
      navigate('Models & creds')
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      await flush()
      let dialog = screen.getByRole('dialog', { name: 'Edit model & credentials' })
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
      fireEvent.click(
        within(dialog).getByLabelText('Current model', { selector: '#llm-primary-model' })
      )
      expect(screen.getByRole('option', { name: new RegExp(modelA) })).not.toHaveTextContent(
        'out of allowlist'
      )
      fireEvent.click(
        within(dialog).getByLabelText('Current model', { selector: '#llm-primary-model' })
      )

      // Reuse the page under a new route/detail producer input. Its real HTTP
      // catalog client must fence A's loaded result as the B binding is hydrated.
      navigation.name = 'quota-agent-b'
      rerenderPage()
      await flush()
      dialog = screen.getByRole('dialog', { name: 'Edit model & credentials' })
      expect(screen.getByRole('heading', { name: 'Agent: Operations agent' })).toBeInTheDocument()
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Try again in 12 seconds.')
      expect(
        within(dialog).getByLabelText('Current model', { selector: '#llm-primary-model' })
      ).toHaveTextContent(modelA)
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
      fireEvent.click(
        within(dialog).getByLabelText('Current model', { selector: '#llm-primary-model' })
      )
      expect(screen.getByRole('option', { name: new RegExp(modelA) })).toHaveTextContent(
        'out of allowlist'
      )
      expect(screen.queryByRole('option', { name: new RegExp(modelB) })).toBeNull()
      fireEvent.click(
        within(dialog).getByLabelText('Current model', { selector: '#llm-primary-model' })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
      await flush()
      expect(within(dialog).queryByRole('alert')).toBeNull()
      fireEvent.click(
        within(dialog).getByLabelText('Current model', { selector: '#llm-primary-model' })
      )
      expect(screen.getByRole('option', { name: new RegExp(modelB) })).not.toHaveTextContent(
        'out of allowlist'
      )
      expect(screen.queryByRole('option', { name: new RegExp(modelA) })).toBeNull()
      expect(api.apiSend).not.toHaveBeenCalled()
    }
  )
})
