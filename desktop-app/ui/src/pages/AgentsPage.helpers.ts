import type { AgentMessageActivity, TaskProgress } from '../uiTypes'

type TaskActionState = {
  taskId?: string
  canAct: boolean
  canCancel: boolean
}

export function resolveTaskActionState(
  activity: AgentMessageActivity | undefined,
  progress: TaskProgress,
  selectedAgent: string | null,
  onCancelTask?: (taskId: string) => void
): TaskActionState {
  const taskId = activity?.taskId ?? progress.taskId
  const hasTaskId = typeof taskId === 'string' && taskId.length > 0
  const isCancelable =
    progress.status === 'active' ||
    progress.status === 'connecting' ||
    progress.status === 'suspended'

  return {
    taskId,
    canAct:
      progress.status === 'suspended' && !!progress.suspendedInfo && !!selectedAgent && hasTaskId,
    canCancel: isCancelable && hasTaskId && !!onCancelTask,
  }
}
