// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useWorkflowController } from '../../hooks/domain/useWorkflowController'
import { WorkflowsPage } from '../WorkflowsPage'

vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ setStatus: vi.fn() }),
}))

vi.mock('../../hooks/domain/useWorkflowController', () => ({
  useWorkflowController: vi.fn(),
}))

const useWorkflowControllerMock = vi.mocked(useWorkflowController)

const SELECTED_WORKFLOW = {
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
    workflows: [SELECTED_WORKFLOW],
    selectedWorkflow: SELECTED_WORKFLOW,
    selectedWorkflowInputContract: null,
    selectedWorkflowSdkCapability: null,
    workflowInputValues: {},
    setWorkflowInputValues: vi.fn(),
    workflowRuns: [],
    workflowRunsLoading: false,
    workflowTriggerLoading: false,
    handleRefreshWorkflows: vi.fn(),
    handleSelectWorkflow: vi.fn(),
    handleTriggerWorkflow: vi.fn(),
    handleRefreshSelectedWorkflow: vi.fn(),
    loadWorkflowRunsFor: vi.fn(),
    clearSelectedWorkflow: vi.fn(),
    resetWorkflows: vi.fn(),
    ...overrides,
  }
}

function renderWorkflowsPage(overrides: Partial<ReturnType<typeof useWorkflowController>> = {}) {
  useWorkflowControllerMock.mockReturnValue(makeWorkflowsValue(overrides))
  return render(<WorkflowsPage />)
}

describe('WorkflowsPage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('uses handleRefreshSelectedWorkflow when the detail card refresh button is clicked', () => {
    const handleRefreshSelectedWorkflow = vi.fn()
    const handleRefreshWorkflows = vi.fn()

    renderWorkflowsPage({ handleRefreshSelectedWorkflow, handleRefreshWorkflows })

    const detailCard = document.querySelector('.workflows-detail-card')
    if (!detailCard) throw new Error('missing workflow detail card')
    fireEvent.click(within(detailCard as HTMLElement).getByRole('button', { name: 'Refresh' }))

    expect(handleRefreshSelectedWorkflow).toHaveBeenCalledOnce()
    expect(handleRefreshWorkflows).not.toHaveBeenCalled()
  })

  it('disables trigger when the selected workflow does not declare a user on-demand trigger', () => {
    const handleTriggerWorkflow = vi.fn()

    renderWorkflowsPage({
      selectedWorkflow: { ...SELECTED_WORKFLOW, triggerableByUser: false },
      handleTriggerWorkflow,
    })

    const detailCard = document.querySelector('.workflows-detail-card')
    if (!detailCard) throw new Error('missing workflow detail card')
    const trigger = within(detailCard as HTMLElement).getByRole('button', { name: 'Trigger' })

    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(handleTriggerWorkflow).not.toHaveBeenCalled()
  })

  it('renders workflow rows as real buttons without test-only hooks', () => {
    const { container } = renderWorkflowsPage()

    expect(screen.getByRole('heading', { name: /^Plugins$/ })).toBeTruthy()

    const row = screen.getByRole('button', { name: /e2e-ondemand-simple/i })
    expect(row.textContent).not.toContain('sandbox-recipes')
    expect(row.textContent).toContain('Active')

    expect(container.querySelector('[data-testid="workflows-page"]')).toBeNull()
    expect(container.querySelector('[data-testid="workflow-row"]')).toBeNull()
  })

  it('downloads workflow artifacts through the run-scoped workflows API', async () => {
    const downloadRunArtifact = vi.fn().mockResolvedValue({
      saved: true,
      filePath: '/Users/test/Downloads/4771438b-custom-sdk-result.json',
      filename: '4771438b-custom-sdk-result.json',
    })
    const rpcDownloadArtifact = vi.fn()
    ;(window as unknown as { clerum: unknown }).clerum = {
      workflows: { downloadRunArtifact },
      rpc: { downloadArtifact: rpcDownloadArtifact },
    }

    renderWorkflowsPage({
      workflowRuns: [
        {
          id: '4771438b-0f8b-47bc-899b-5177b03b742f',
          phase: 'Succeeded',
          triggeredAt: '2026-05-06T00:00:00.000Z',
          startedAt: '2026-05-06T00:00:01.000Z',
          completedAt: '2026-05-06T00:00:10.000Z',
          message: null,
          actor: { type: 'user', userId: 'user-123' },
          executionRef: {
            namespace: 'sandbox-recipes',
            name: 'child-run-one',
          },
          source: 'live',
          artifacts: [
            {
              name: 'custom-sdk-result.json',
              format: 'json',
              sizeBytes: 42,
              createdAt: '2026-05-06T00:00:10.000Z',
            },
          ],
        },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'custom-sdk-result.json' }))

    await waitFor(() => {
      expect(downloadRunArtifact).toHaveBeenCalledWith(
        'sandbox-recipes',
        'e2e-ondemand-simple',
        '4771438b-0f8b-47bc-899b-5177b03b742f',
        'custom-sdk-result.json'
      )
    })
    expect(
      await screen.findByText('Saved 4771438b-custom-sdk-result.json to Downloads.')
    ).toBeTruthy()
    expect(rpcDownloadArtifact).not.toHaveBeenCalled()
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
      selectedWorkflow: null,
    })

    expect(screen.getByText('completed').className).toContain('allowed')
    expect(screen.getByText('failed').className).toContain('denied')
  })
})
