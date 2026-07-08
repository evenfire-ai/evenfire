import type { WorkflowInputValues } from '../../../../src/types'
import type { WorkflowSummary } from '../../workflows.types'
import type { SetStatusFn } from './types'

export interface UseWorkflowControllerParams {
  setStatus: SetStatusFn
}

export interface WorkflowSelectionState {
  selectedWorkflow: WorkflowSummary | null
  workflowInputValues: WorkflowInputValues
  workflowTriggerLoading: boolean
  selectionVersion: number
}

export const EMPTY_WORKFLOW_SELECTION: WorkflowSelectionState = {
  selectedWorkflow: null,
  workflowInputValues: {},
  workflowTriggerLoading: false,
  selectionVersion: 0,
}

export function createResetWorkflowSelection(
  current?: WorkflowSelectionState
): WorkflowSelectionState {
  return {
    ...EMPTY_WORKFLOW_SELECTION,
    selectionVersion: (current?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion) + 1,
  }
}
