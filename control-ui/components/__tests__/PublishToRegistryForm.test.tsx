import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { getPublishScope } from '../../lib/api'
import { PublishScopeProvider, resetPublishScopeCache } from '../../lib/hooks/usePublishScope'
import { PublishToRegistryForm } from '../PublishToRegistryForm'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getPublishScope: vi.fn(),
    publishToRegistry: vi.fn(),
  }
})

// EgressEditor renders an interactive sub-form we don't exercise here; stub it
// so the publish stepper's Package step stays simple to drive in tests.
vi.mock('../EgressEditor', () => ({
  EgressEditor: () => null,
}))

function render(children: ReactNode) {
  return rtlRender(
    <ToastProvider>
      <PublishScopeProvider cacheKey="admin-1">{children}</PublishScopeProvider>
    </ToastProvider>
  )
}

async function advanceToReviewStep() {
  // Step 0 — Entry: name.
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'my-connector' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  // Step 1 — Metadata: version, author, description.
  await waitFor(() => expect(screen.getByLabelText(/Version/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Version/), { target: { value: '1.0.0' } })
  fireEvent.change(screen.getByLabelText(/Author/), { target: { value: 'Acme' } })
  fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'A connector.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  // Step 2 — Package: use the remote connector mode (no image/egress required).
  // The connector-mode toggle renders as role="tab" (TabBar), not a plain button.
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Remote' })).toBeInTheDocument())
  fireEvent.click(screen.getByRole('tab', { name: 'Remote' }))
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: 'https://mcp.example.com/sse' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  // Step 3 — Review.
  await waitFor(() =>
    expect(screen.getByText(/No description yet|A connector\./)).toBeInTheDocument()
  )
}

describe('PublishToRegistryForm publish target', () => {
  beforeEach(() => {
    vi.mocked(getPublishScope).mockReset()
    resetPublishScopeCache()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    resetPublishScopeCache()
  })

  it('shows the org publish target when the caller is bound to an org', async () => {
    // Mirror the real server contract: registryClient.ts emits an @-prefixed
    // scope (e.g. "@newtenantwf") and orgName is a lowercase slug.
    vi.mocked(getPublishScope).mockResolvedValue({
      scope: '@newtenantwf',
      curator: false,
      orgName: 'newtenantwf',
    })

    render(<PublishToRegistryForm onPublished={vi.fn()} onCancel={vi.fn()} />)

    await advanceToReviewStep()

    await waitFor(() => expect(screen.getByText(/Publishing to your org:/)).toBeInTheDocument())
    // Exactly one @ — guards against the double-@ regression.
    expect(screen.getByText('@newtenantwf')).toBeInTheDocument()
    expect(screen.getByText(/@newtenantwf\/my-connector/)).toBeInTheDocument()
    expect(getPublishScope).toHaveBeenCalledTimes(1)
  })

  it('shows the public catalog target when the caller is the curator', async () => {
    vi.mocked(getPublishScope).mockResolvedValue({
      scope: null,
      curator: true,
      orgName: null,
    })

    render(<PublishToRegistryForm onPublished={vi.fn()} onCancel={vi.fn()} />)

    await advanceToReviewStep()

    await waitFor(() =>
      expect(screen.getByText(/Publishing to the public catalog \(@clerum\)/)).toBeInTheDocument()
    )
    expect(getPublishScope).toHaveBeenCalledTimes(1)
  })
})
