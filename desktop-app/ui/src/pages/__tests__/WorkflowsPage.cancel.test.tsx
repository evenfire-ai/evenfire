// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkflowRunListItem } from '../../../../src/types'
import {
  useWorkflowController,
  useWorkflowRecentRuns,
} from '../../hooks/domain/useWorkflowController'
import { WorkflowsPage } from '../WorkflowsPage'

const setStatusSpy = vi.fn()

vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ setStatus: setStatusSpy }),
}))

// Only the hooks are mocked; the pure run-phase helpers the page reads stay real.
vi.mock('../../hooks/domain/useWorkflowController', async importOriginal => ({
  ...(await importOriginal<typeof import('../../hooks/domain/useWorkflowController')>()),
  useWorkflowController: vi.fn(),
  useWorkflowRecentRuns: vi.fn(),
}))

const useWorkflowControllerMock = vi.mocked(useWorkflowController)
const useWorkflowRecentRunsMock = vi.mocked(useWorkflowRecentRuns)

const WORKFLOW = {
  namespace: 'sandbox-recipes',
  name: 'e2e-cancel-two-step',
  status: 'Active',
  createdAt: '2026-11-26T00:00:00Z',
  triggerableByUser: true,
}

const RUN_ID = '7f0b4c1e-3a52-4d0e-9a51-1f6f0d1f2b3c'

function makeRun(overrides: Partial<WorkflowRunListItem>): WorkflowRunListItem {
  return {
    id: RUN_ID,
    source: 'live',
    phase: 'Running',
    triggeredAt: '2026-11-26T10:00:00Z',
    startedAt: '2026-11-26T10:00:01Z',
    completedAt: null,
    message: null,
    actor: null,
    executionRef: null,
    cancelRequestedAt: null,
    viewerCanCancel: false,
    ...overrides,
  }
}

function renderWithLatestRun(run: WorkflowRunListItem, cancelRun = vi.fn(async () => undefined)) {
  useWorkflowControllerMock.mockReturnValue({
    workflowsLoading: false,
    workflowsError: null,
    workflows: [WORKFLOW],
    handleSelectWorkflow: vi.fn().mockResolvedValue(null),
    handleTriggerWorkflow: vi.fn().mockResolvedValue(undefined),
    cancelRun,
  } as unknown as ReturnType<typeof useWorkflowController>)
  useWorkflowRecentRunsMock.mockReturnValue({
    latestRun: run,
    runCount: 1,
    loading: false,
    refreshing: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  render(<WorkflowsPage />)
  return within(screen.getByRole('table'))
}

type Row = {
  case: string
  viewerCanCancel: boolean
  phase: string
  cancelRequestedAt: string | null
  button: boolean
  pill: string
}

const REQUESTED_AT = '2026-11-26T10:00:05Z'

// Button only when the viewer may cancel, the run is non-terminal and no cancel was
// requested; "Canceling" when non-terminal with a request; neither on a terminal run.
const ROWS: Row[] = [
  {
    case: 'running, may cancel',
    viewerCanCancel: true,
    phase: 'Running',
    cancelRequestedAt: null,
    button: true,
    pill: 'Running',
  },
  {
    case: 'pending, may cancel',
    viewerCanCancel: true,
    phase: 'Pending',
    cancelRequestedAt: null,
    button: true,
    pill: 'Pending',
  },
  {
    case: 'running, may not cancel',
    viewerCanCancel: false,
    phase: 'Running',
    cancelRequestedAt: null,
    button: false,
    pill: 'Running',
  },
  {
    case: 'pending, may not cancel',
    viewerCanCancel: false,
    phase: 'Pending',
    cancelRequestedAt: null,
    button: false,
    pill: 'Pending',
  },
  {
    case: 'running, cancel requested',
    viewerCanCancel: true,
    phase: 'Running',
    cancelRequestedAt: REQUESTED_AT,
    button: false,
    pill: 'Canceling',
  },
  {
    case: 'running, cancel requested, may not cancel',
    viewerCanCancel: false,
    phase: 'Running',
    cancelRequestedAt: REQUESTED_AT,
    button: false,
    pill: 'Canceling',
  },
  {
    case: 'pending, cancel requested',
    viewerCanCancel: true,
    phase: 'Pending',
    cancelRequestedAt: REQUESTED_AT,
    button: false,
    pill: 'Canceling',
  },
  {
    case: 'authorization paused, may cancel',
    viewerCanCancel: true,
    phase: 'AuthorizationPaused',
    cancelRequestedAt: null,
    button: true,
    pill: 'AuthorizationPaused',
  },
  {
    case: 'authorization paused, cancel requested',
    viewerCanCancel: true,
    phase: 'AuthorizationPaused',
    cancelRequestedAt: REQUESTED_AT,
    button: false,
    pill: 'Canceling',
  },
  {
    case: 'succeeded, may cancel',
    viewerCanCancel: true,
    phase: 'Succeeded',
    cancelRequestedAt: null,
    button: false,
    pill: 'Succeeded',
  },
  {
    case: 'failed, may cancel',
    viewerCanCancel: true,
    phase: 'Failed',
    cancelRequestedAt: null,
    button: false,
    pill: 'Failed',
  },
  {
    case: 'canceled after a request',
    viewerCanCancel: true,
    phase: 'Canceled',
    cancelRequestedAt: REQUESTED_AT,
    button: false,
    pill: 'Canceled',
  },
  {
    case: 'succeeded after a request',
    viewerCanCancel: false,
    phase: 'Succeeded',
    cancelRequestedAt: REQUESTED_AT,
    button: false,
    pill: 'Succeeded',
  },
]

describe('WorkflowsPage cancel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it.each(ROWS)('Cancel button visibility and the Canceling state: $case', row => {
    const table = renderWithLatestRun(
      makeRun({
        viewerCanCancel: row.viewerCanCancel,
        phase: row.phase,
        cancelRequestedAt: row.cancelRequestedAt,
        completedAt:
          row.phase === 'Succeeded' || row.phase === 'Failed' || row.phase === 'Canceled'
            ? '2026-11-26T10:00:20Z'
            : null,
      })
    )

    // Liveness witness: the latest run itself rendered in the row.
    const pill = table.getByTestId('workflow-latest-run-phase')
    expect(pill.textContent).toBe(row.pill)

    const button = table.queryByRole('button', { name: 'Cancel run' })
    if (row.button) {
      expect(button).not.toBeNull()
    } else {
      expect(button).toBeNull()
    }
  })

  it('clicking Cancel calls cancelRun with the recipe and the latest run id', async () => {
    const cancelRun = vi.fn(async () => undefined)
    const table = renderWithLatestRun(makeRun({ viewerCanCancel: true }), cancelRun)

    fireEvent.click(table.getByRole('button', { name: 'Cancel run' }))

    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(1))
    expect(cancelRun).toHaveBeenCalledWith(WORKFLOW.namespace, WORKFLOW.name, RUN_ID)
  })
})
