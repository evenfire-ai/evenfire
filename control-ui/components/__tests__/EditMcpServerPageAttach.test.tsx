import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from '@constants/connectorCredentials'
import * as api from '@lib/api'
import type { McpServerResource } from '@lib/api'
import EditMcpServerPage from '../../app/mcp-servers/[name]/edit/page'

const navigation = vi.hoisted(() => ({ tab: 'credentials', push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useParams: () => ({ name: 'search', tab: navigation.tab }),
  useRouter: () => navigation,
}))
vi.mock('@components/AuthGate', () => ({ AuthGate: ({ children }) => children }))
vi.mock('@components/DashboardLayout', () => ({ DashboardLayout: ({ children }) => children }))
vi.mock('@lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@lib/api')>()),
  getMcpServer: vi.fn(),
  getMcpServers: vi.fn(),
  getHosts: vi.fn(),
  getContexts: vi.fn(),
  listMcpSecrets: vi.fn(),
  createMcpSecret: vi.fn(),
  updateMcpSecret: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpSecret: vi.fn(),
}))
let current: McpServerResource
async function flush() {
  for (let i = 0; i < 30; i++)
    await act(async () => {
      await Promise.resolve()
    })
}
function page() {
  return (
    <ToastProvider>
      <EditMcpServerPage />
    </ToastProvider>
  )
}
async function open() {
  const result = render(page())
  await flush()
  return result
}
async function submit() {
  fireEvent.change(screen.getByLabelText(/^Secret name/), { target: { value: 'secret' } })
  fireEvent.change(screen.getByLabelText(/^Secret key 1/), { target: { value: 'api-key' } })
  fireEvent.change(screen.getByLabelText(/^Environment variable 1/), {
    target: { value: 'API_KEY' },
  })
  fireEvent.change(screen.getByLabelText(/^Credential value 1/), { target: { value: 'value' } })
  fireEvent.click(screen.getByRole('button', { name: 'Attach and restart' }))
  await flush()
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Attach and restart' })
  )
  await flush()
}
async function tick(ms = POLL_INTERVAL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-23T12:00:00Z')
  vi.resetAllMocks()
  navigation.tab = 'credentials'
  current = {
    metadata: { name: 'search', uid: 'uid', resourceVersion: '12', generation: 2 },
    spec: { image: 'example/search:v1' },
  }
  vi.mocked(api.getMcpServer).mockImplementation(async () => structuredClone(current))
  vi.mocked(api.getMcpServers).mockResolvedValue({ items: [] })
  vi.mocked(api.getHosts).mockResolvedValue({ items: [] })
  vi.mocked(api.getContexts).mockResolvedValue({ items: [] })
  vi.mocked(api.createMcpSecret).mockResolvedValue({
    name: 'secret',
    namespace: 'mcp-server',
    uid: 'secret-uid',
    resourceVersion: '1',
  })
  vi.mocked(api.updateMcpServer).mockImplementation(async (_name, payload) => {
    current = {
      ...current,
      metadata: { ...current.metadata, generation: 3, resourceVersion: '13' },
      spec: payload.spec,
    }
    return structuredClone(current)
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('keyless edit credentials journey', () => {
  it('keeps egress blocked after an unknown save and hides stale settings if refresh fails', async () => {
    vi.mocked(api.updateMcpServer).mockRejectedValue(new TypeError('network'))
    await open()
    await submit()
    expect(screen.getByRole('tab', { name: 'External Egress' })).toBeDisabled()
    vi.mocked(api.getMcpServer).mockRejectedValue(new Error('Connector read unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credentials' }))
    await flush()
    expect(screen.queryByRole('button', { name: 'Attach and restart' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Connector read unavailable')
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })

  it('renders attach in the existing centered edit card', async () => {
    await open()
    expect(screen.getByRole('heading', { name: 'Attach credentials' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit Connector: search' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Attach and restart' }).closest('.cu-connector-edit-form')
    ).not.toBeNull()
  })
  it.each([
    { managed: false },
    { enabled: false },
    { envSecret: null },
    { envSecret: { name: 'broken' } },
    { oauth: {} },
    { oauth: null },
    { oauth: { id: 'x', provider: 'slack' } },
    { oauth: { id: 'x', source: 'generic' } },
    { oauth: { id: 'x', source: 'remote' } },
  ])('does not offer attach for excluded state %j', async spec => {
    current.spec = { ...current.spec, ...spec }
    await open()
    expect(screen.queryByRole('button', { name: 'Attach and restart' })).not.toBeInTheDocument()
    expect(api.createMcpSecret).not.toHaveBeenCalled()
  })
  it('retains the running panel after spec save, then refreshes into rotation on correlated success', async () => {
    await open()
    await submit()
    expect(screen.getByText(/Waiting for search to become ready/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'External Egress' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    current.status = {
      conditions: [
        {
          type: 'DeploymentReady',
          status: 'True',
          reason: 'ReplicasAvailable',
          message: '',
          observedGeneration: 2,
          lastTransitionTime: new Date().toISOString(),
        },
      ],
    }
    await tick()
    expect(screen.getByRole('heading', { name: 'Attach credentials' })).toBeInTheDocument()
    current.status.conditions[0].observedGeneration = 3
    await tick()
    expect(screen.getByRole('button', { name: 'Rotate api-key' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Attach credentials' })).not.toBeInTheDocument()
    expect(api.createMcpSecret).toHaveBeenCalledOnce()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('refreshes a saved timed-out attachment into rotation without another create', async () => {
    await open()
    await submit()
    await tick(POLL_TIMEOUT_MS)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credentials' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Rotate api-key' })).toBeInTheDocument()
    expect(api.createMcpSecret).toHaveBeenCalledOnce()
    expect(api.deleteMcpSecret).not.toHaveBeenCalled()
  })
  it('blocks attach until unsaved egress changes are explicitly discarded', async () => {
    navigation.tab = 'egress'
    const view = await open()
    fireEvent.change(screen.getByLabelText('Egress mode'), { target: { value: 'public-web' } })
    await flush()
    navigation.tab = 'credentials'
    view.rerender(page())
    await flush()
    expect(screen.getByRole('button', { name: 'Attach and restart' })).toBeDisabled()
    expect(screen.getByText(/Save or discard your egress changes/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard egress changes' }))
    expect(screen.getByRole('button', { name: 'Attach and restart' })).toBeEnabled()
  })
  it('supports the existing static remote header-placeholder path with an explicit limitation', async () => {
    current.spec.remote = {
      baseUrl: 'https://api.example.com',
      authHeaders: [{ name: 'X-API-Key', valueTemplate: '${API_KEY}' }],
    }
    await open()
    expect(screen.getByText(/attaching does not add headers/)).toBeInTheDocument()
    await submit()
    expect(api.updateMcpServer).toHaveBeenCalledWith(
      'search',
      expect.objectContaining({ spec: expect.objectContaining({ remote: current.spec.remote }) })
    )
  })
})
