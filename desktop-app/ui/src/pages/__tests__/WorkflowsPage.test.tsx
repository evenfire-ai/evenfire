// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkflowInputContractSchema } from '../../../../src/types'
import {
  useWorkflowController,
  useWorkflowRecentRuns,
} from '../../hooks/domain/useWorkflowController'
import { WorkflowsPage } from '../WorkflowsPage'

const setStatusSpy = vi.fn()

vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ setStatus: setStatusSpy }),
}))

vi.mock('../../hooks/domain/useWorkflowController', () => ({
  useWorkflowController: vi.fn(),
  useWorkflowRecentRuns: vi.fn(),
}))

const useWorkflowControllerMock = vi.mocked(useWorkflowController)
const useWorkflowRecentRunsMock = vi.mocked(useWorkflowRecentRuns)

const CONTRACT: WorkflowInputContractSchema = {
  properties: {
    topic: { type: 'string', default: 'initial topic' },
  },
}

const WORKFLOW = {
  namespace: 'sandbox-recipes',
  name: 'e2e-ondemand-simple',
  status: 'Active',
  createdAt: '2026-04-22T12:00:00Z',
  triggerableByUser: true,
}

function makeWorkflowsValue(
  overrides: Partial<ReturnType<typeof useWorkflowController>> = {}
): ReturnType<typeof useWorkflowController> {
  return {
    workflowsLoading: false,
    workflowsError: null,
    workflows: [WORKFLOW],
    selectedWorkflow: null,
    selectedWorkflowInputContract: null,
    workflowInputValues: {},
    setWorkflowInputValues: vi.fn(),
    workflowRuns: [],
    workflowRunsLoading: false,
    workflowTriggerLoading: false,
    handleRefreshWorkflows: vi.fn(),
    handleSelectWorkflow: vi.fn().mockResolvedValue(null),
    handleTriggerWorkflow: vi.fn().mockResolvedValue(undefined),
    loadWorkflowRunsFor: vi.fn(),
    clearSelectedWorkflow: vi.fn(),
    resetWorkflows: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useWorkflowController>
}

function makeRecentRuns(
  overrides: Partial<ReturnType<typeof useWorkflowRecentRuns>> = {}
): ReturnType<typeof useWorkflowRecentRuns> {
  return {
    latestRun: null,
    runCount: 0,
    loading: false,
    refreshing: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderWorkflowsPage(
  overrides: Partial<ReturnType<typeof useWorkflowController>> = {},
  recent: Partial<ReturnType<typeof useWorkflowRecentRuns>> = {}
) {
  useWorkflowControllerMock.mockReturnValue(makeWorkflowsValue(overrides))
  useWorkflowRecentRunsMock.mockReturnValue(makeRecentRuns(recent))
  return render(<WorkflowsPage />)
}

describe('WorkflowsPage', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  // Invariant 1: flat DataTable with Name/Status/Recent Runs/Actions columns,
  // one row per plugin, no inline accordion / detail panel.
  it('renders a flat table with columns and one row per plugin, no accordion', () => {
    const { container } = renderWorkflowsPage()

    expect(screen.getByRole('heading', { name: /^Plugins$/ })).toBeTruthy()

    for (const header of ['Name', 'Status', 'Recent Runs', 'Actions']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy()
    }

    // One data row for the single plugin; the row shows the name (not the
    // namespace) and the recipe status.
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    // 1 header row + 1 data row
    expect(rows).toHaveLength(2)
    const dataRow = rows[1]!
    expect(within(dataRow).getByText('e2e-ondemand-simple')).toBeTruthy()
    expect(dataRow.textContent).not.toContain('sandbox-recipes')
    expect(within(dataRow).getByText('Active')).toBeTruthy()

    // No accordion / detail panel survives.
    expect(container.querySelector('.workflows-detail-card')).toBeNull()
    expect(container.querySelector('.workflows-detail-extension')).toBeNull()
    expect(container.querySelector('.da-grid')).toBeNull()
  })

  // Invariant 2a: Trigger on a recipe WITH an input contract opens the modal
  // and does not fire the trigger yet; confirming the modal fires it.
  it('opens the Trigger modal for a recipe with an input contract', async () => {
    const handleTriggerWorkflow = vi.fn().mockResolvedValue(undefined)
    renderWorkflowsPage({
      handleSelectWorkflow: vi.fn().mockResolvedValue(CONTRACT),
      selectedWorkflowInputContract: CONTRACT,
      handleTriggerWorkflow,
    })

    const rowTrigger = within(screen.getByRole('table')).getByRole('button', { name: 'Trigger' })
    fireEvent.click(rowTrigger)

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: /Trigger e2e-ondemand-simple/ })
    ).toBeTruthy()
    expect(dialog.querySelector('.input-contract-form')).not.toBeNull()
    // Not fired until the user confirms.
    expect(handleTriggerWorkflow).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Trigger' }))
    await waitFor(() =>
      expect(handleTriggerWorkflow).toHaveBeenCalledWith('sandbox-recipes', 'e2e-ondemand-simple')
    )
  })

  // Invariant 2b: Trigger on a recipe WITHOUT a contract fires directly, no modal.
  it('triggers directly (no modal) for a recipe without an input contract', async () => {
    const handleTriggerWorkflow = vi.fn().mockResolvedValue(undefined)
    renderWorkflowsPage({
      handleSelectWorkflow: vi.fn().mockResolvedValue(null),
      selectedWorkflowInputContract: null,
      handleTriggerWorkflow,
    })

    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: 'Trigger' }))

    await waitFor(() =>
      expect(handleTriggerWorkflow).toHaveBeenCalledWith(
        'sandbox-recipes',
        'e2e-ondemand-simple',
        {}
      )
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // H2: while the Trigger modal is open, every row's Trigger button is disabled.
  // ConfirmDialog has no focus trap, so a keyboard user could otherwise tab to
  // another row and activate it, resetting the modal's global selection state.
  it('disables every row Trigger button while the Trigger modal is open', async () => {
    const WF_A = { ...WORKFLOW, name: 'recipe-a' }
    const WF_B = { ...WORKFLOW, name: 'recipe-b' }
    renderWorkflowsPage({
      workflows: [WF_A, WF_B],
      handleSelectWorkflow: vi.fn().mockResolvedValue(CONTRACT),
      selectedWorkflowInputContract: CONTRACT,
    })

    const table = screen.getByRole('table')
    const rowTriggers = within(table).getAllByRole('button', { name: 'Trigger' })
    expect(rowTriggers).toHaveLength(2)
    // Both enabled before the modal opens.
    expect((rowTriggers[0] as HTMLButtonElement).disabled).toBe(false)
    expect((rowTriggers[1] as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(rowTriggers[0]!)
    await screen.findByRole('dialog')

    // With the modal open, every row Trigger is disabled (not just the opener).
    for (const btn of within(table).getAllByRole('button', { name: 'Trigger' })) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('does not fire trigger when the recipe declares no user on-demand trigger', () => {
    const handleTriggerWorkflow = vi.fn()
    renderWorkflowsPage({
      workflows: [{ ...WORKFLOW, triggerableByUser: false }],
      handleTriggerWorkflow,
    })

    const trigger = within(screen.getByRole('table')).getByRole('button', { name: 'Trigger' })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(handleTriggerWorkflow).not.toHaveBeenCalled()
  })

  // Invariant 3: Recent Runs shows the compact latest-run summary + a count,
  // never the full expanded run list.
  it('renders a compact Recent Runs summary, not the full run list', () => {
    renderWorkflowsPage(
      {},
      {
        latestRun: {
          id: '4771438b-0f8b-47bc-899b-5177b03b742f',
          source: 'live',
          phase: 'Succeeded',
          triggeredAt: '2026-05-06T00:00:00.000Z',
          startedAt: '2026-05-06T00:00:01.000Z',
          completedAt: '2026-05-06T00:00:10.000Z',
          message: null,
          actor: null,
          executionRef: { namespace: 'sandbox-recipes', name: 'child-run-one' },
          artifacts: [],
        },
        runCount: 3,
      }
    )

    const table = screen.getByRole('table')
    expect(within(table).getByText('Succeeded')).toBeTruthy()
    expect(within(table).getByText(/3 runs/)).toBeTruthy()
    // Compact: exactly one run status pill in the row, never a full list.
    expect(within(table).getAllByText('Succeeded')).toHaveLength(1)
  })

  // M3: a failed runs fetch (recent.error) must not read as "No runs yet".
  it('shows a load failure in the Recent Runs cell instead of "No runs yet"', () => {
    renderWorkflowsPage({}, { error: 'runs boom', latestRun: null, loading: false })

    const table = screen.getByRole('table')
    expect(within(table).getByText('Failed to load runs')).toBeTruthy()
    expect(within(table).queryByText('No runs yet')).toBeNull()
  })

  it('downloads the latest run artifact through the run-scoped workflows API', async () => {
    const downloadRunArtifact = vi.fn().mockResolvedValue({
      saved: true,
      filePath: '/Users/test/Downloads/4771438b-custom-sdk-result.json',
      filename: '4771438b-custom-sdk-result.json',
    })
    ;(window as unknown as { clerum: unknown }).clerum = {
      workflows: { downloadRunArtifact },
    }

    renderWorkflowsPage(
      {},
      {
        latestRun: {
          id: '4771438b-0f8b-47bc-899b-5177b03b742f',
          source: 'live',
          phase: 'Succeeded',
          triggeredAt: '2026-05-06T00:00:00.000Z',
          startedAt: '2026-05-06T00:00:01.000Z',
          completedAt: '2026-05-06T00:00:10.000Z',
          message: null,
          actor: null,
          executionRef: { namespace: 'sandbox-recipes', name: 'child-run-one' },
          artifacts: [
            { name: 'custom-sdk-result.json', format: 'json', sizeBytes: 42, createdAt: 'x' },
          ],
        },
        runCount: 1,
      }
    )

    fireEvent.click(screen.getByRole('button', { name: 'custom-sdk-result.json' }))

    await waitFor(() => {
      expect(downloadRunArtifact).toHaveBeenCalledWith(
        'sandbox-recipes',
        'e2e-ondemand-simple',
        '4771438b-0f8b-47bc-899b-5177b03b742f',
        'custom-sdk-result.json'
      )
    })
    await waitFor(() =>
      expect(setStatusSpy).toHaveBeenCalledWith(
        'Saved 4771438b-custom-sdk-result.json to Downloads.',
        'success',
        undefined,
        { global: false, toast: true }
      )
    )
  })

  it('does not style completed recipes as failed', () => {
    renderWorkflowsPage({
      workflows: [
        {
          namespace: 'sandbox-recipes',
          name: 'done-recipe',
          status: 'completed',
          triggerableByUser: true,
        },
        {
          namespace: 'sandbox-recipes',
          name: 'failed-recipe',
          status: 'failed',
          triggerableByUser: true,
        },
      ],
    })

    expect(screen.getByText('completed').className).toContain('ui-pill--success')
    expect(screen.getByText('failed').className).toContain('ui-pill--danger')
  })
})
