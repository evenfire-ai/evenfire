// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkflowInputContractSchema, WorkflowRunListItem } from '../../../../src/types'
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

const WORKFLOW_B = {
  namespace: 'sandbox-recipes',
  name: 'e2e-cancel-scheduled',
  status: 'Active',
  createdAt: '2026-11-26T00:00:00Z',
  triggerableByUser: true,
}

const RUN_ID = '7f0b4c1e-3a52-4d0e-9a51-1f6f0d1f2b3c'
const RUN_ID_B = '2c9d81aa-6f1e-4b7c-8d3e-5a4b3c2d1e0f'
const NEWER_RUN_ID = '9e8d7c6b-1a2b-4c3d-8e9f-0a1b2c3d4e5f'

type CancelRun = (ns: string, name: string, runId: string) => Promise<void>

function deferred() {
  // The executor runs synchronously, so resolve is assigned before it is returned.
  let resolve!: () => void
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

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

function makeRecentRuns(run: WorkflowRunListItem): ReturnType<typeof useWorkflowRecentRuns> {
  return {
    latestRun: run,
    runCount: 1,
    loading: false,
    refreshing: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

function mockController(workflows: (typeof WORKFLOW)[], cancelRun: CancelRun) {
  useWorkflowControllerMock.mockReturnValue({
    workflowsLoading: false,
    workflowsError: null,
    workflows,
    handleSelectWorkflow: vi.fn().mockResolvedValue(null),
    handleTriggerWorkflow: vi.fn().mockResolvedValue(undefined),
    cancelRun,
  } as unknown as ReturnType<typeof useWorkflowController>)
}

function renderWithLatestRunAndRerender(
  run: WorkflowRunListItem,
  cancelRun: CancelRun = vi.fn(async () => undefined)
) {
  mockController([WORKFLOW], cancelRun)
  useWorkflowRecentRunsMock.mockReturnValue(makeRecentRuns(run))
  const { rerender } = render(<WorkflowsPage />)
  return { table: within(screen.getByRole('table')), rerender }
}

function renderWithLatestRun(
  run: WorkflowRunListItem,
  cancelRun: CancelRun = vi.fn(async () => undefined)
) {
  return renderWithLatestRunAndRerender(run, cancelRun).table
}

// Two recipes, each with a running run the viewer may cancel.
function renderTwoWorkflows(cancelRun: CancelRun) {
  mockController([WORKFLOW, WORKFLOW_B], cancelRun)
  useWorkflowRecentRunsMock.mockImplementation(wf =>
    makeRecentRuns(
      makeRun({ id: wf.name === WORKFLOW_B.name ? RUN_ID_B : RUN_ID, viewerCanCancel: true })
    )
  )
  render(<WorkflowsPage />)
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

// Written out rather than imported, so a change to the page's sentence fails here.
const CANCEL_EFFECT =
  'A running run stops at the first step boundary after its coordinator receives the signal (normally within 5 s). A step that starts before then still runs, and steps that already ran are not undone.'

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

  it('the Cancel tooltip says when a cancel takes effect', () => {
    const table = renderWithLatestRun(makeRun({ viewerCanCancel: true }))

    // Liveness witness: the button is found by its accessible name.
    const button = table.getByRole('button', { name: 'Cancel run' })
    expect(button.getAttribute('title')).toBe(`Cancel this run. ${CANCEL_EFFECT}`)
  })

  it('Cancel asks first and sends one request on confirm', async () => {
    const call = deferred()
    const cancelRun = vi.fn(() => call.promise)
    const table = renderWithLatestRun(makeRun({ viewerCanCancel: true }), cancelRun)

    fireEvent.click(table.getByRole('button', { name: 'Cancel run' }))

    // Liveness witness: the dialog is found before asserting that nothing was sent.
    const dialog = screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })
    expect(within(dialog).getByText(CANCEL_EFFECT)).toBeTruthy()
    expect(cancelRun).not.toHaveBeenCalled()

    const confirm = within(dialog).getByRole('button', { name: 'Cancel run' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(cancelRun).toHaveBeenCalledTimes(1)
    expect(cancelRun).toHaveBeenCalledWith(WORKFLOW.namespace, WORKFLOW.name, RUN_ID)
    // While the request is pending the dialog stays and refuses dismissal.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }))
    expect(screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })).toBe(dialog)

    await act(async () => {
      call.resolve()
      await call.promise
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(cancelRun).toHaveBeenCalledTimes(1)
  })

  it('Keep running sends nothing', () => {
    const cancelRun = vi.fn(async () => undefined)
    const table = renderWithLatestRun(makeRun({ viewerCanCancel: true }), cancelRun)

    fireEvent.click(table.getByRole('button', { name: 'Cancel run' }))
    // Liveness witness: the dialog was shown first.
    const dialog = screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cancelRun).not.toHaveBeenCalled()
  })

  it("a second row cannot replace the dialog's run", async () => {
    const cancelRun = vi.fn(async () => undefined)
    renderTwoWorkflows(cancelRun)
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    const rowA = rows[1]
    const rowB = rows[2]
    if (!rowA || !rowB) throw new Error('expected two workflow rows')

    fireEvent.click(within(rowA).getByRole('button', { name: 'Cancel run' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })

    fireEvent.click(within(rowB).getByRole('button', { name: 'Cancel run' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })).toBe(dialog)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(cancelRun).toHaveBeenCalledTimes(1)
    expect(cancelRun).toHaveBeenCalledWith(WORKFLOW.namespace, WORKFLOW.name, RUN_ID)
  })

  it('the dialog keeps the run it was opened for', async () => {
    const cancelRun = vi.fn(async () => undefined)
    const { table, rerender } = renderWithLatestRunAndRerender(
      makeRun({ viewerCanCancel: true }),
      cancelRun
    )

    fireEvent.click(table.getByRole('button', { name: 'Cancel run' }))
    screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })

    // A newer run becomes the latest while the dialog is open.
    useWorkflowRecentRunsMock.mockReturnValue(
      makeRecentRuns(makeRun({ id: NEWER_RUN_ID, viewerCanCancel: true }))
    )
    rerender(<WorkflowsPage />)
    expect(useWorkflowRecentRunsMock).toHaveLastReturnedWith(
      expect.objectContaining({ latestRun: expect.objectContaining({ id: NEWER_RUN_ID }) })
    )

    // The title still names the first run, and confirming cancels that run.
    const dialog = screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(cancelRun).toHaveBeenCalledTimes(1)
    expect(cancelRun).toHaveBeenCalledWith(WORKFLOW.namespace, WORKFLOW.name, RUN_ID)
  })

  it('the Trigger modal and the cancel confirmation never open together', async () => {
    const contract: WorkflowInputContractSchema = {
      properties: { topic: { type: 'string', default: 'initial topic' } },
    }
    const recipeRead = deferred()
    const handleSelectWorkflow = vi
      .fn()
      .mockResolvedValueOnce(contract)
      .mockReturnValueOnce(recipeRead.promise.then(() => contract))
    const handleTriggerWorkflow = vi.fn().mockResolvedValue(undefined)
    const cancelRun = vi.fn(async () => undefined)
    useWorkflowControllerMock.mockReturnValue({
      workflowsLoading: false,
      workflowsError: null,
      workflows: [WORKFLOW, WORKFLOW_B],
      selectedWorkflowInputContract: contract,
      workflowInputValues: { topic: 'initial topic' },
      setWorkflowInputValues: vi.fn(),
      workflowTriggerLoading: false,
      handleSelectWorkflow,
      handleTriggerWorkflow,
      cancelRun,
    } as unknown as ReturnType<typeof useWorkflowController>)
    useWorkflowRecentRunsMock.mockImplementation(wf =>
      makeRecentRuns(
        makeRun({ id: wf.name === WORKFLOW_B.name ? RUN_ID_B : RUN_ID, viewerCanCancel: true })
      )
    )
    render(<WorkflowsPage />)
    const table = within(screen.getByRole('table'))
    const triggerButtons = () => table.getAllByRole('button', { name: 'Trigger' })
    const cancelButtons = () => table.getAllByRole('button', { name: 'Cancel run' })
    expect(triggerButtons()).toHaveLength(2)
    expect(cancelButtons()).toHaveLength(2)

    // (1) The cancel confirmation is open: every row's Trigger is disabled.
    fireEvent.click(cancelButtons()[0] as HTMLElement)
    const cancelDialog = screen.getByRole('dialog', { name: 'Cancel run 7f0b4c1e?' })
    for (const button of triggerButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }

    // (2) After "Keep running", Trigger opens the Trigger modal: every row's Cancel is
    // disabled and it is the only dialog.
    fireEvent.click(within(cancelDialog).getByRole('button', { name: 'Keep running' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(triggerButtons()[0] as HTMLElement)
    const triggerDialog = await screen.findByRole('dialog', {
      name: `Trigger ${WORKFLOW.name}`,
    })
    for (const button of cancelButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    // (3) While a Trigger waits for its recipe read, every row's Cancel is disabled;
    // when the read resolves the Trigger modal opens alone.
    fireEvent.click(within(triggerDialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    handleSelectWorkflow.mockClear()
    fireEvent.click(triggerButtons()[0] as HTMLElement)
    expect(handleSelectWorkflow).toHaveBeenCalledTimes(1)
    for (const button of cancelButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => {
      recipeRead.resolve()
      await recipeRead.promise
    })
    await screen.findByRole('dialog', { name: `Trigger ${WORKFLOW.name}` })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(cancelRun).not.toHaveBeenCalled()
    expect(handleTriggerWorkflow).not.toHaveBeenCalled()
  })
})
