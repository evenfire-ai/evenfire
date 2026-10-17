import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TokenBudgetForm } from '../TokenBudgetForm'

vi.mock('@lib/hooks/useSubscriptionCapabilities', () => ({
  useSubscriptionCapabilities: () => ({
    capabilities: { providers: {} },
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}))

vi.mock('@lib/hooks/useLlmAllowedModels', () => ({
  useLlmAllowedModels: () => ({ models: [], loading: false, error: '' }),
}))

vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
    getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
    getHosts: vi.fn().mockResolvedValue({ items: [] }),
    getRecipeSecrets: vi.fn().mockResolvedValue({ items: [] }),
    getLlmPrices: vi.fn().mockResolvedValue({ rows: [] }),
  }
})

const noop = () => undefined

afterEach(cleanup)

describe('TokenBudgetForm — thresholds copy', () => {
  it('describes per-task guardrails as enforced today, not deferred', () => {
    render(<TokenBudgetForm mode="create" saving={false} onSubmit={noop} onCancel={noop} />)

    // control-api's budget check denies below min-start and mcp-host's task
    // brake aborts over max-per-task for block budgets, so the copy must not
    // promise enforcement in a later phase.
    expect(screen.queryByText(/later phase/i)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        /With Block enforcement, a task cannot start below the minimum remaining and is stopped once it exceeds the per-task cap\./
      )
    ).toBeInTheDocument()
  })
})
