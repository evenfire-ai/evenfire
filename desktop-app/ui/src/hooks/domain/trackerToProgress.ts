import type { TaskState, TaskStatus } from '@contexts/AgentTaskTrackerContext'
import type { TaskProgress } from '@/uiTypes'

/** Map the tracker's lifecycle status to the ProgressStepper's status union. */
export function mapTrackerStatusToProgress(status: TaskStatus): TaskProgress['status'] {
  switch (status) {
    case 'connecting':
      return 'connecting'
    case 'streaming':
      return 'active'
    case 'suspended':
      return 'suspended'
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'error'
  }
}

/**
 * Adapt a tracker `TaskState` to the `TaskProgress` the `ProgressStepper`
 * consumes (D.5 in-flight placeholder). Mirrors the controller's live
 * subscribe-effect mapping so a rejoined task (no local message bubble) renders
 * identically to a locally-started one.
 */
export function trackerStateToTaskProgress(state: TaskState): TaskProgress {
  return {
    taskId: state.taskId,
    status: mapTrackerStatusToProgress(state.status),
    steps: state.steps,
    currentIteration: state.currentIteration,
    llmElapsedMs: state.llmElapsedMs,
    suspendedInfo: state.pendingApproval
      ? {
          requestId: state.pendingApproval.requestId,
          displayName: state.pendingApproval.displayName || 'Unknown Tool',
          // U5: carried so the stepper renders "Connect <server>" for a
          // connect_required suspension instead of the generic approval prompt.
          reason: state.pendingApproval.reason,
          mcpServerName: state.pendingApproval.mcpServerName,
          provider: state.pendingApproval.provider,
        }
      : undefined,
    cancelReason:
      state.terminalResult?.kind === 'cancelled' ? state.terminalResult.reason : undefined,
  }
}
