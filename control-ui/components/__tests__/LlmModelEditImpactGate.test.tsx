import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CreateLlmModelInput, LlmAllowedModel } from '@lib/api'
import { formatApiError, getLlmModel, updateLlmModel } from '@lib/api'
import EditLlmModelPage from '../../app/llm-models/[id]/edit/page'

const mockPush = vi.fn()
const mockShowToast = vi.fn()

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
vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
// Trimmed form: exposes a submit trigger that emits a disable (enabled:false)
// payload so the page's saveWithImpactGate runs end to end. A distinctive label
// (not the loading skeleton's own "Save model" button) so the query resolves to
// the loaded form, never the transient skeleton.
const SUBMIT_INPUT: CreateLlmModelInput = {
  provider: 'claude',
  model: 'claude-haiku-4-5',
  enabled: false,
}
// A rename keeps the row enabled but changes the (provider, model) identity, so
// control-api gates it over the OLD pair (R1-H1). The `mock` prefix lets the
// hoisted vi.mock factory close over it; each test sets what the form emits.
let mockSubmitInput: CreateLlmModelInput = SUBMIT_INPUT
const RENAME_INPUT: CreateLlmModelInput = {
  provider: 'claude',
  model: 'claude-opus-4-8',
  enabled: true,
}
const SUBMIT_LABEL = 'Submit model edit'
vi.mock('@components/LlmModelForm', () => ({
  LlmModelForm: ({ onSubmit }: { onSubmit: (input: CreateLlmModelInput) => void }) => (
    <button type="button" onClick={() => onSubmit(mockSubmitInput)}>
      {SUBMIT_LABEL}
    </button>
  ),
}))
vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return { ...actual, getLlmModel: vi.fn(), updateLlmModel: vi.fn() }
})

// Derive the rejected Error from the REAL client error producer (formatApiError,
// lib/api.ts) instead of re-implementing its `.status`/`.code`/`.body` shape by
// hand (T1). A change to how control-ui represents an API error now flows into
// these tests rather than silently diverging from a hand-mirrored copy.
function structuredApiError(status: number, body: Record<string, unknown>): Error {
  const text = JSON.stringify(body)
  const res = new Response(text, { status, headers: { 'content-type': 'application/json' } })
  return formatApiError(res, text)
}

const model: LlmAllowedModel = {
  id: 'model-1',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  vendor: 'Anthropic',
  display_name: 'Claude Haiku',
  context_window_tokens: null,
  enabled: true,
  source: 'discovery',
  stale: true,
  discovered_at: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function inUseError(): Error {
  return structuredApiError(409, {
    error: 'model_in_use',
    message: 'still referenced',
    impact: {
      provider: 'claude',
      model: 'claude-haiku-4-5',
      hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
      grantsAffected: [
        {
          id: 'g1',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'nightly-summary',
          capabilityFamily: 'promptBridge',
        },
      ],
    },
  })
}

describe('edit page disable impact gate (409 model_in_use → force)', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockShowToast.mockClear()
    mockSubmitInput = SUBMIT_INPUT
    // vi.clearAllMocks() in afterEach clears call history but NOT the queued
    // mockRejectedValueOnce/mockResolvedValueOnce values; reset updateLlmModel so
    // an unconsumed queued value from one test can never leak into the next.
    vi.mocked(updateLlmModel).mockReset()
    vi.mocked(getLlmModel).mockResolvedValue(model)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the impact and retries with ?force after the operator confirms', async () => {
    vi.mocked(updateLlmModel).mockRejectedValueOnce(inUseError()).mockResolvedValueOnce(model)

    render(<EditLlmModelPage />)

    fireEvent.click(await screen.findByRole('button', { name: SUBMIT_LABEL }))

    // Impact confirm: shows the stranded references before forcing the disable.
    expect(await screen.findByRole('button', { name: 'Disable anyway' })).toBeInTheDocument()
    expect(screen.getByText('mcp-host/agent-a')).toBeInTheDocument()
    expect(screen.getByText(/promptBridge/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Disable anyway' }))

    await waitFor(() => {
      expect(vi.mocked(updateLlmModel)).toHaveBeenCalledTimes(2)
    })
    // First attempt without force, retry with { force: true }.
    expect(vi.mocked(updateLlmModel).mock.calls[0]).toEqual(['model-1', SUBMIT_INPUT, {}])
    expect(vi.mocked(updateLlmModel).mock.calls[1]).toEqual([
      'model-1',
      SUBMIT_INPUT,
      { force: true },
    ])
    await waitFor(() => expect(mockPush).toHaveBeenCalled())
  })

  // R1-H1 widened the gate: renaming an enabled pair also trips the 409, computed
  // over the OLD pair. The confirm must name that old pair (from the impact body,
  // not the freshly-typed new identity) and say "Rename", not "Disable".
  it('names the old pair and offers a rename override when a rename is gated', async () => {
    mockSubmitInput = RENAME_INPUT
    vi.mocked(updateLlmModel).mockRejectedValueOnce(inUseError()).mockResolvedValueOnce(model)

    render(<EditLlmModelPage />)

    fireEvent.click(await screen.findByRole('button', { name: SUBMIT_LABEL }))

    // The verb is "Rename", not "Disable" — nothing is being disabled here.
    expect(await screen.findByRole('button', { name: 'Rename anyway' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable anyway' })).not.toBeInTheDocument()
    // Names the OLD, still-referenced pair (impact body) and the new target — never
    // claims the new identity "is still referenced".
    expect(
      screen.getByText(
        /claude\/claude-haiku-4-5 is still referenced\. Renaming it to claude\/claude-opus-4-8/
      )
    ).toBeInTheDocument()
    expect(screen.getByText('mcp-host/agent-a')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename anyway' }))

    await waitFor(() => {
      expect(vi.mocked(updateLlmModel)).toHaveBeenCalledTimes(2)
    })
    expect(vi.mocked(updateLlmModel).mock.calls[0]).toEqual(['model-1', RENAME_INPUT, {}])
    expect(vi.mocked(updateLlmModel).mock.calls[1]).toEqual([
      'model-1',
      RENAME_INPUT,
      { force: true },
    ])
    await waitFor(() => expect(mockPush).toHaveBeenCalled())
  })

  it('does not force when the operator cancels the impact confirm', async () => {
    vi.mocked(updateLlmModel).mockRejectedValueOnce(inUseError())

    render(<EditLlmModelPage />)

    fireEvent.click(await screen.findByRole('button', { name: SUBMIT_LABEL }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Disable anyway' })).not.toBeInTheDocument()
    })
    expect(vi.mocked(updateLlmModel)).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
  })
})
