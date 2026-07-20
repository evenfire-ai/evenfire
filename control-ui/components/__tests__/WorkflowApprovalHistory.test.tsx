import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getWorkflowRun } from '@lib/api'
import { getGovernedApprovalPromptHistory } from '@lib/governedTrace'
import { WorkflowApprovalHistory } from '../GovernedTraceSurface/WorkflowApprovalHistory'

vi.mock('@lib/api', () => ({ getWorkflowRun: vi.fn() }))
vi.mock('@lib/governedTrace', () => ({ getGovernedApprovalPromptHistory: vi.fn() }))

const mockGetWorkflowRun = vi.mocked(getWorkflowRun)
const mockGetPromptHistory = vi.mocked(getGovernedApprovalPromptHistory)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkflowApprovalHistory', () => {
  it('does not create an approval section without a canonical request id', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      id: 'run-1',
      source: 'live',
      approvalRequestId: null,
      phase: 'Succeeded',
      triggeredAt: null,
      startedAt: null,
      completedAt: null,
      message: null,
      actor: null,
      executionRef: null,
    })

    render(<WorkflowApprovalHistory namespace="sandbox-recipes" name="demo" runId="run-1" />)

    await waitFor(() => expect(mockGetWorkflowRun).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Workflow approval history')).not.toBeInTheDocument()
  })

  it('uses the canonical request id and reads prompt evidence only after explicit action', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      id: 'run-1',
      source: 'live',
      approvalRequestId: 'approval-1',
      phase: 'Succeeded',
      triggeredAt: null,
      startedAt: null,
      completedAt: null,
      message: null,
      actor: { type: 'user', userId: 'user-1' },
      executionRef: null,
    })
    mockGetPromptHistory.mockResolvedValue({
      approvalRequestId: 'approval-1',
      availability: 'disabled',
      prompt: null,
    })

    render(<WorkflowApprovalHistory namespace="sandbox-recipes" name="demo" runId="run-1" />)

    await waitFor(() => expect(screen.getByText('Workflow approval history')).toBeInTheDocument())
    expect(screen.getByText('approval-1')).toBeInTheDocument()
    expect(screen.getByText('user-1')).toBeInTheDocument()
    expect(mockGetPromptHistory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Check protected prompt history' }))

    await waitFor(() => expect(mockGetPromptHistory).toHaveBeenCalledWith('approval-1'))
    expect(screen.getByText('Prompt history: disabled')).toBeInTheDocument()
  })
})
