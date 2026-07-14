import type { WorkflowPhase } from './types'

export function workflowStatusMessage(phase: WorkflowPhase, failureReason?: string): string {
  if (failureReason) return failureReason
  switch (phase) {
    case 'pending':
      return 'Workflow pending'
    case 'initializing':
      return 'Workflow initializing'
    case 'running':
      return 'Workflow running'
    case 'recovering':
      return 'Workflow recovering'
    case 'completed':
      return 'Workflow completed'
    case 'failed':
      return 'Workflow failed'
    case 'cancelled':
      return 'Workflow cancelled'
    default: {
      const exhaustive: never = phase
      return String(exhaustive)
    }
  }
}
