// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkflowRunListItem, WorkflowRunsResult } from '../../../../src/types'
import type { WorkflowSummary } from '../../workflows.types'
import {
  WORKFLOW_CANCELING_REFETCH_INTERVAL_MS,
  useWorkflowController,
  useWorkflowRecentRuns,
} from '../domain/useWorkflowController'

const WORKFLOW: WorkflowSummary = {
  namespace: 'sandbox-recipes',
  name: 'two-step',
  status: 'Active',
  createdAt: '2026-11-26T00:00:00Z',
  triggerableByUser: true,
}

function makeRun(overrides: Partial<WorkflowRunListItem> = {}): WorkflowRunListItem {
  return {
    id: 'run-1',
    source: 'live',
    phase: 'Running',
    triggeredAt: '2026-11-26T10:00:00Z',
    startedAt: '2026-11-26T10:00:01Z',
    completedAt: null,
    message: null,
    actor: null,
    executionRef: null,
    cancelRequestedAt: null,
    viewerCanCancel: true,
    ...overrides,
  }
}

function runsOf(run: WorkflowRunListItem): WorkflowRunsResult {
  return { items: [run], count: 1 }
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

type SetStatus = Parameters<typeof useWorkflowController>[0]['setStatus']

function Harness({ setStatus }: { setStatus: SetStatus }) {
  const recent = useWorkflowRecentRuns(WORKFLOW)
  const controller = useWorkflowController({ setStatus })
  const latest = recent.latestRun
  return (
    <div>
      <div data-testid="latest-phase">{latest?.phase ?? 'none'}</div>
      <div data-testid="latest-cancel-requested">{latest?.cancelRequestedAt ?? 'none'}</div>
      <button
        type="button"
        onClick={() => void controller.cancelRun(WORKFLOW.namespace, WORKFLOW.name, 'run-1')}
      >
        Cancel latest
      </button>
    </div>
  )
}

function installClerum(runs: ReturnType<typeof vi.fn>, cancelRun: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      workflows: {
        runs,
        cancelRun,
        listRunArtifacts: vi.fn(async () => ({ artifacts: [] })),
      },
    },
  })
}

function renderHarness(setStatus: SetStatus) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness setStatus={setStatus} />
    </QueryClientProvider>
  )
}

// Advance fake time, then let a read that started inside that window resolve and
// reach the render: the query result passes through promise hops and a batched
// notification scheduled on a timer, so a few 1 ms steps are flushed after the jump.
// The steps add a few milliseconds, far below the refetch interval.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  for (let step = 0; step < 5; step++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'clerum')
})

describe('useWorkflowController cancelRun', () => {
  it('cancelRun invalidates the runs query; a failure shows an error and changes nothing', async () => {
    // Success: the IPC call is made once and the recipe's runs are read again once.
    let requested = false
    const runs = vi.fn(async () =>
      runsOf(
        requested
          ? makeRun({ cancelRequestedAt: '2026-11-26T10:00:05Z', viewerCanCancel: false })
          : makeRun()
      )
    )
    const cancelRun = vi.fn(async () => {
      requested = true
      return { run: makeRun({ cancelRequestedAt: '2026-11-26T10:00:05Z' }) }
    })
    installClerum(runs, cancelRun)
    const setStatus = vi.fn<SetStatus>()
    renderHarness(setStatus)
    await waitFor(() => expect(screen.getByTestId('latest-phase').textContent).toBe('Running'))
    expect(runs).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel latest' }))

    await waitFor(() =>
      expect(screen.getByTestId('latest-cancel-requested').textContent).toBe('2026-11-26T10:00:05Z')
    )
    expect(cancelRun).toHaveBeenCalledTimes(1)
    expect(cancelRun).toHaveBeenCalledWith(WORKFLOW.namespace, WORKFLOW.name, 'run-1')
    expect(runs).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenCalledWith('Cancel requested.', 'success', undefined, {
      global: false,
      toast: true,
    })
    cleanup()

    // Failure: an error status, no refetch, the cell unchanged.
    const failingRuns = vi.fn(async () => runsOf(makeRun()))
    const failingCancel = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'workflows:cancelRun': Error: 409 Conflict: workflow_run_not_cancellable"
      )
    })
    installClerum(failingRuns, failingCancel)
    const failureStatus = vi.fn<SetStatus>()
    renderHarness(failureStatus)
    await waitFor(() => expect(screen.getByTestId('latest-phase').textContent).toBe('Running'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel latest' }))

    await waitFor(() => expect(failureStatus).toHaveBeenCalledTimes(1))
    // Liveness witness: the IPC call was made exactly once.
    expect(failingCancel).toHaveBeenCalledTimes(1)
    expect(failureStatus).toHaveBeenCalledWith(
      "Cancel failed: Error invoking remote method 'workflows:cancelRun': Error: 409 Conflict: workflow_run_not_cancellable",
      'error'
    )
    expect(failingRuns).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('latest-phase').textContent).toBe('Running')
    expect(screen.getByTestId('latest-cancel-requested').textContent).toBe('none')
  })

  it('refetches while Canceling and stops at a terminal phase', async () => {
    vi.useFakeTimers()
    const canceling = makeRun({
      cancelRequestedAt: '2026-11-26T10:00:05Z',
      viewerCanCancel: false,
    })
    const canceled = makeRun({
      phase: 'Canceled',
      completedAt: '2026-11-26T10:00:20Z',
      cancelRequestedAt: '2026-11-26T10:00:05Z',
      viewerCanCancel: false,
    })
    const responses = [canceling, canceling, canceled]
    let reads = 0
    const runs = vi.fn(async () => {
      const response = responses[Math.min(reads++, responses.length - 1)]
      if (!response) throw new Error('no scripted runs response')
      return runsOf(response)
    })
    installClerum(
      runs,
      vi.fn(async () => undefined)
    )
    renderHarness(vi.fn<SetStatus>())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(runs).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('latest-phase').textContent).toBe('Running')
    expect(screen.getByTestId('latest-cancel-requested').textContent).toBe('2026-11-26T10:00:05Z')

    // Nothing is re-read before the interval elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_CANCELING_REFETCH_INTERVAL_MS - 1)
    })
    expect(runs).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(runs).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('latest-phase').textContent).toBe('Running')

    await advance(WORKFLOW_CANCELING_REFETCH_INTERVAL_MS)
    // The third read reached the terminal phase without a manual refresh.
    expect(runs).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('latest-phase').textContent).toBe('Canceled')

    // At a terminal phase the interval stops: no further reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_CANCELING_REFETCH_INTERVAL_MS * 4)
    })
    expect(runs).toHaveBeenCalledTimes(3)
  })

  it('does not poll a non-terminal run that has no cancel request', async () => {
    vi.useFakeTimers()
    const runs = vi.fn(async () => runsOf(makeRun()))
    installClerum(
      runs,
      vi.fn(async () => undefined)
    )
    renderHarness(vi.fn<SetStatus>())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // Liveness witness: the initial read ran and rendered the running run.
    expect(runs).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('latest-phase').textContent).toBe('Running')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_CANCELING_REFETCH_INTERVAL_MS * 4)
    })
    expect(runs).toHaveBeenCalledTimes(1)
  })
})
