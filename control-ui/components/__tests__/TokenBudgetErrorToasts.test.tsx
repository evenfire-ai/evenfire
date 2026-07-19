import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import EditLlmPricePage from '../../app/cost/llm-prices/[id]/edit/page'
import CreateTokenBudgetPage from '../../app/cost/token-budgets/new/page'
import {
  createTokenBudget,
  getAdminTeams,
  getAdminUsers,
  getHosts,
  getLlmPrice,
  getLlmPrices,
  getRecipeSecrets,
  updateLlmPrice,
} from '../../lib/api'

const mockPush = vi.fn()
const mockShowToast = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'price-1' }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getAdminTeams: vi.fn(),
    getAdminUsers: vi.fn(),
    getHosts: vi.fn(),
    getRecipeSecrets: vi.fn(),
    getLlmPrices: vi.fn(),
    getLlmPrice: vi.fn(),
    createTokenBudget: vi.fn(),
    updateLlmPrice: vi.fn(),
    // The budget/price forms load the model allowlist via useLlmAllowedModels.
    getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  }
})

// Mirrors the Error shape produced by lib/api.ts formatApiError: message plus the
// preserved structured `.body`/`.code` that the typed helpers read.
function structuredApiError(status: number, body: Record<string, unknown>): Error {
  const error = new Error(`${status} Bad Request - ${String(body.error)}`)
  ;(error as Error & { status?: number }).status = status
  ;(error as Error & { code?: string }).code = String(body.error)
  ;(error as Error & { body?: unknown }).body = body
  return error
}

describe('structured budget/price errors surface an error toast', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockShowToast.mockClear()
    vi.mocked(getAdminTeams).mockResolvedValue({ items: [] })
    vi.mocked(getAdminUsers).mockResolvedValue({ items: [] })
    vi.mocked(getHosts).mockResolvedValue({ items: [] })
    vi.mocked(getRecipeSecrets).mockResolvedValue({ items: [] })
    vi.mocked(getLlmPrices).mockResolvedValue({ rows: [] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('fires an error toast (not the raw string) on 400 unpriced_models when creating a budget', async () => {
    vi.mocked(createTokenBudget).mockRejectedValue(
      structuredApiError(400, {
        error: 'unpriced_models',
        message: 'internal detail',
        models: [
          { provider: 'openai', model: 'gpt-5' },
          { provider: 'anthropic', model: 'claude-x' },
        ],
      })
    )

    render(<CreateTokenBudgetPage />)

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Cap' } })
    fireEvent.change(screen.getByLabelText(/Limit amount/), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create budget' }))

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('no active price'), {
        tone: 'error',
      })
    })
    // The concise toast reports the real count and never leaks the raw HTTP string.
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('2 models'), {
      tone: 'error',
    })
    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.stringContaining('400 Bad Request'),
      expect.anything()
    )
    // The actionable inline banner (list + link) also renders alongside the toast.
    expect(screen.getByText(/openai\/gpt-5/)).toBeInTheDocument()
    // The raw generic error string must never appear on screen for this code.
    expect(screen.queryByText(/400 Bad Request/)).not.toBeInTheDocument()
  })

  it('fires an error toast (not the raw string) on 409 price_in_use_by_budget when saving a price', async () => {
    vi.mocked(getLlmPrice).mockResolvedValue({
      id: 'price-1',
      provider: 'openai',
      model: 'gpt-5',
      input_token_price: 1,
      output_token_price: 2,
      cache_read_token_price: 0,
      cache_write_token_price: 0,
      currency: 'USD',
      effective_from: '2026-01-01T00:00:00.000Z',
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    vi.mocked(updateLlmPrice).mockRejectedValue(
      structuredApiError(409, {
        error: 'price_in_use_by_budget',
        budgets: [{ id: 'b1', name: 'Monthly cap' }],
      })
    )

    render(<EditLlmPricePage />)

    // Wait for the loaded price form, then submit.
    const saveButton = await screen.findByRole('button', { name: 'Save price' })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('used by 1 budget'), {
        tone: 'error',
      })
    })
    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.stringContaining('409'),
      expect.anything()
    )
    // Actionable inline banner with the blocking budget name renders too.
    expect(screen.getByText('Monthly cap')).toBeInTheDocument()
    expect(screen.queryByText(/409 Bad Request/)).not.toBeInTheDocument()
  })
})
