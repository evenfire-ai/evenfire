import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LlmAllowedModel } from '@lib/api'
import { getLlmModel } from '@lib/api'
import EditLlmModelPage from '../../app/llm-models/[id]/edit/page'
import { llmModelWireRow } from '../../test/fixtures/llmModelRows'

// control-api treats any `enabled` that differs from the locked row as the
// operator's decision. The catalog sync can flip the row while the page is open,
// so a metadata-only save must not carry the `enabled` the page loaded: it would
// undo the sync's change and hand the row to the operator for good. The real
// form is driven through its inputs and the PUT body is read off the real
// client, over rows control-api generated.

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'model-1' }),
}))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/CreateFlowPanel', () => ({
  CreateFlowPanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/CreatePageHeader', () => ({ CreatePageHeader: () => null }))
vi.mock('@components/Sidebar/icons', () => ({ IconModels: () => null }))
vi.mock('@components/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
// The form reads subscription capabilities over the network; they only gate
// which subscription providers are offered, never the Enabled toggle for the
// API-key rows used here.
vi.mock('@lib/hooks/useSubscriptionCapabilities', () => ({
  useSubscriptionCapabilities: () => ({
    capabilities: null,
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}))
vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return { ...actual, getLlmModel: vi.fn() }
})

describe('edit page sends enabled only when the operator changes it', () => {
  const sentBodies: Array<Record<string, unknown>> = []

  beforeEach(() => {
    mockPush.mockClear()
    sentBodies.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') sentBodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(llmModelWireRow(true)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function save(loaded: LlmAllowedModel, edit: { toggleEnabled: boolean }) {
    vi.mocked(getLlmModel).mockResolvedValue(loaded)
    render(<EditLlmModelPage />)
    fireEvent.change(await screen.findByLabelText('Display name'), {
      target: { value: 'Renamed label' },
    })
    if (edit.toggleEnabled) fireEvent.click(screen.getByRole('checkbox', { name: /^Enabled/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalled())
    expect(sentBodies).toHaveLength(1)
    return sentBodies[0]
  }

  it('omits enabled from a metadata-only save of an enabled model', async () => {
    const body = await save(llmModelWireRow(true), { toggleEnabled: false })
    expect(body).not.toHaveProperty('enabled')
    expect(body).not.toHaveProperty('pinEnabled')
    expect(body).toMatchObject({ display_name: 'Renamed label' })
  })

  it('omits enabled from a metadata-only save of a disabled model', async () => {
    const body = await save(llmModelWireRow(false), { toggleEnabled: false })
    expect(body).not.toHaveProperty('enabled')
    expect(body).not.toHaveProperty('pinEnabled')
    expect(body).toMatchObject({ display_name: 'Renamed label' })
  })

  it('sends enabled:false with the pin when the operator turns an enabled model off', async () => {
    const body = await save(llmModelWireRow(true), { toggleEnabled: true })
    expect(body).toMatchObject({ enabled: false, pinEnabled: true, display_name: 'Renamed label' })
  })

  it('sends enabled:true with the pin when the operator turns a disabled model on', async () => {
    const body = await save(llmModelWireRow(false), { toggleEnabled: true })
    expect(body).toMatchObject({ enabled: true, pinEnabled: true, display_name: 'Renamed label' })
  })
})
