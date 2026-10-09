import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { listCodexSubscriptionConnections } from '@lib/codexSubscription'
import { listGrokSubscriptionConnections } from '@lib/grokSubscription'
import { RecipeEditor } from '../RecipeEditor'
import { ToastProvider } from '../Toast'

vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getControlUINamespaces: vi
      .fn()
      .mockResolvedValue({ sandbox: 'sandbox-recipes', mcpServer: 'mcp-server' }),
  }
})
vi.mock('@lib/codexSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/codexSubscription')>()
  return { ...actual, listCodexSubscriptionConnections: vi.fn() }
})
vi.mock('@lib/grokSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/grokSubscription')>()
  return { ...actual, listGrokSubscriptionConnections: vi.fn() }
})
vi.mock('@components/WorkflowAccessPanel', () => ({
  WorkflowAccessPanel: () => <section aria-label="Workflow access">Loaded access</section>,
}))

const recipe = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: {
    name: 'quota-recipe',
    namespace: 'sandbox-recipes',
    resourceVersion: 'recipe-rv-1',
    annotations: { 'clerum.io/subscription-connection-ref': 'team-codex' },
  },
  spec: {
    agent: { provider: 'codex-subscription', model: 'gpt-5.1' },
    steps: [{ id: 'summarize', instruction: 'Summarize the report.' }],
    workloads: [],
    triggers: { onDemand: {} },
  },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RecipeEditor optional subscription throttling', () => {
  it('loads only the selected broker at review and keeps a saved grant through throttling and retry', async () => {
    vi.mocked(listCodexSubscriptionConnections)
      .mockRejectedValueOnce(
        Object.assign(new Error('Try again in 12 seconds.'), {
          status: 429,
          code: 'rate_limited',
          retryAfterSeconds: 12,
        })
      )
      .mockResolvedValueOnce([
        {
          connectionKey: 'team-codex',
          displayName: 'Team subscription',
          status: 'connected',
          catalogStatus: 'ready',
        },
      ] as never)
    render(
      <ToastProvider>
        <RecipeEditor initial={recipe as never} onSaved={vi.fn()} onCancel={vi.fn()} />
      </ToastProvider>
    )
    expect(listCodexSubscriptionConnections).not.toHaveBeenCalled()
    expect(listGrokSubscriptionConnections).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }))
    const review = await screen.findByRole('button', { name: 'Apply defaults' })
    expect(review).toBeEnabled()
    fireEvent.click(review)
    const access = await screen.findByRole('button', { name: /^4Access & deploy/ })
    await waitFor(() => expect(access).toBeEnabled())
    fireEvent.click(access)
    const panel = await screen.findByTestId('codex-recipe-grant')
    const alert = await within(panel).findByRole('alert')
    expect(alert).toHaveTextContent('Try again in 12 seconds.')
    expect(within(panel).getByText('team-codex')).toBeInTheDocument()
    expect(within(panel).queryByText('team-codex (unavailable)')).toBeNull()
    expect(listGrokSubscriptionConnections).not.toHaveBeenCalled()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await within(panel).findByText('Team subscription')).toBeInTheDocument()
    await waitFor(() => expect(within(panel).queryByRole('alert')).toBeNull())
  })
})
