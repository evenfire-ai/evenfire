// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkflowRecipeResource } from '../../../../src/types'
import { desktopQueryKeys } from '../../hooks/domain/queryKeys'
import { WorkflowsPage } from '../WorkflowsPage'

// H1 regression: a recipe that DECLARES a required input contract, but whose
// `workflows.read` fails transiently, must not fall through to a contract-less
// trigger. The old code swallowed the read error to `null`, which the page read
// as "no inputs" and fired `trigger({})`, skipping the input modal entirely.
// This drives the REAL useWorkflowController (not a mock) so the swallow →
// direct-trigger path is exercised end to end.

const setStatusSpy = vi.fn()

vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ setStatus: setStatusSpy }),
}))

// A recipe with an on-demand user trigger AND a required input contract. The
// read fails below, so the page can never learn the contract — which is exactly
// the condition the fix must not misread as "no contract".
const WORKFLOW_RESOURCE: WorkflowRecipeResource = {
  metadata: {
    namespace: 'sandbox-recipes',
    name: 'needs-inputs',
    creationTimestamp: '2026-05-18T00:00:00Z',
  },
  spec: {
    triggers: { onDemand: { allowedActors: ['user'] } },
    inputContract: { properties: { topic: { type: 'string' } } },
  },
  status: { phase: 'Active' },
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('WorkflowsPage — recipe read failure on Trigger (H1)', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('does not fire a contract-less trigger when the recipe read fails; shows an error', async () => {
    const trigger = vi.fn(async () => undefined)
    ;(window as unknown as { clerum: unknown }).clerum = {
      workflows: {
        list: vi.fn(async () => ({ items: [WORKFLOW_RESOURCE], count: 1 })),
        read: vi.fn(async () => {
          throw new Error('read boom')
        }),
        runs: vi.fn(async () => ({ items: [], count: 0 })),
        listRunArtifacts: vi.fn(async () => ({ artifacts: [] })),
        trigger,
      },
    }

    const queryClient = createQueryClient()
    // Seed the (enabled:false) workflows query so the flat table has a row.
    queryClient.setQueryData(desktopQueryKeys.workflows, {
      items: [WORKFLOW_RESOURCE],
      count: 1,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowsPage />
      </QueryClientProvider>
    )

    const rowTrigger = within(screen.getByRole('table')).getByRole('button', { name: 'Trigger' })
    fireEvent.click(rowTrigger)

    // Observable result: an error status is surfaced.
    await waitFor(() =>
      expect(setStatusSpy).toHaveBeenCalledWith(expect.stringContaining('Trigger failed'), 'error')
    )
    // The bug: the read failure must never fire a trigger, and no modal opens.
    expect(trigger).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
